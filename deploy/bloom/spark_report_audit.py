#!/usr/bin/env python3
"""Offline audit of spark .sparkprofile and .sparkhealth protobuf captures.

No dependencies, networking, JVM startup, or server changes. Capture-wide
entity snapshots must NOT be treated as window-by-window entity observations.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import struct

MAX_BYTES = 256 * 1024 * 1024


def _varint(buf, pos):
    number = 0
    for shift in range(0, 70, 7):
        if pos >= len(buf):
            raise ValueError('Truncated protobuf varint')
        byte = buf[pos]
        pos += 1
        number |= (byte & 127) << shift
        if byte < 128:
            return number, pos
    raise ValueError('Oversized protobuf varint')


def _fields(buf):
    pos = 0
    while pos < len(buf):
        tag, pos = _varint(buf, pos)
        fid, wire = tag >> 3, tag & 7
        if fid < 1:
            raise ValueError('Invalid protobuf field number')
        if wire == 0:
            value, pos = _varint(buf, pos)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            if pos + size > len(buf):
                raise ValueError('Truncated protobuf fixed-width field')
            value = buf[pos:pos + size]
            pos += size
        elif wire == 2:
            size, pos = _varint(buf, pos)
            if size > len(buf) - pos:
                raise ValueError('Truncated protobuf length-delimited field')
            value = buf[pos:pos + size]
            pos += size
        else:
            raise ValueError(f'Unsupported protobuf wire type {wire}')
        yield fid, wire, value


def _msg(buf):
    result = {}
    for fid, wire, value in _fields(buf):
        result.setdefault(fid, []).append((wire, value))
    return result


def _get(obj, key, wire=None, default=None):
    vals = obj.get(key, [])
    if not vals:
        return default
    w, value = vals[0]
    if wire is not None and wire != w:
        raise ValueError(f'Unexpected protobuf wire for field {key}')
    return value


def _text(buf):
    return bytes(buf).decode('utf-8', errors='replace')


def _double(raw):
    return struct.unpack('<d', raw)[0]


def _utc(epoch_millis):
    return datetime.fromtimestamp(epoch_millis / 1000, timezone.utc).isoformat().replace('+00:00', 'Z')


def _stats(root, kind):
    # Spark Profile: SamplerData.metadata[1].platformStatistics[8]
    # Spark Health: HealthData.platformStatistics[1][3]
    outer = _msg(_get(root, 1, 2))
    if kind == 'profile':
        platform = _msg(_get(outer, 8, 2))
        snap_ms = _get(outer, 11, 0) or _get(outer, 2, 0)
    else:
        platform = _msg(_get(outer, 3, 2))
        snap_ms = _get(outer, 5, 0)
    world_data = _msg(_get(platform, 8, 2))
    return kind, outer, world_data, snap_ms


def _entities(world_data):
    total = _get(world_data, 1, 0)
    if total is None:
        raise ValueError('Spark capture lacks world entity statistics')
    mobs = Counter()
    for wire, raw in world_data.get(2, []):
        row = _msg(raw)
        mobs[_text(_get(row, 1, 2))] += _get(row, 2, 0, 0)
    regions = []
    world_counts = {}
    chunks_containing_entities = 0
    for wire, raw in world_data.get(3, []):
        world = _msg(raw)
        name = _text(_get(world, 1, 2))
        world_counts[name] = _get(world, 2, 0, 0)
        for _, regraw in world.get(3, []):
            region = _msg(regraw)
            count = _get(region, 1, 0, 0)
            chunk_count = len(region.get(2, []))
            chunks_containing_entities += chunk_count
            # Region-level entity type totals can be extracted from each chunk.
            region_mobs = Counter()
            for _, chunkraw in region.get(2, []):
                chunk = _msg(chunkraw)
                for _, mobraw in chunk.get(4, []):
                    mob = _msg(mobraw)
                    region_mobs[_text(_get(mob, 1, 2))] += _get(mob, 2, 0, 0)
            regions.append({'world': name, 'entities': count,
                            'chunksWithEntities': chunk_count,
                            'topMobs': dict(region_mobs.most_common(5))})
    regions.sort(key=lambda row: row['entities'], reverse=True)
    return {'total': total, 'mobs': dict(mobs.most_common()),
            'worldCounts': world_counts,
            'chunksWithEntities': chunks_containing_entities,
            'largestRegions': regions[:5]}


def _windows(root, slow_sampler=False):
    windows = []
    for _, raw in root.get(7, []):
        env = _msg(raw)
        if not env.get(2):
            continue
        metric = _msg(_get(env, 2, 2))
        if not any(key in metric for key in (1, 4, 5, 6, 7)):
            continue
        def number(field):
            entry = metric.get(field)
            if not entry:
                return None
            wire, value = entry[0]
            return _double(value) if wire == 1 else value
        windows.append({
            'startUtc': _utc(number(11)) if number(11) is not None else None,
            'endUtc': _utc(number(12)) if number(12) is not None else None,
            'tps': number(4), 'medianMspt': number(5),
            'maxTickMs': number(6), 'players': number(7),
            'slowTicks': number(1) if slow_sampler else None,
        })
    return sorted(windows, key=lambda row: row['startUtc'] or '')


def _health_counter(row, field):
    """Proto3 omitted int32 values are zero; reject negative or invalid counters."""
    value = _get(row, field, 0, 0)
    max_signed = (1 << 31) - 1
    if max_signed < value < (1 << 64) - (1 << 31):
        raise ValueError(f'Health minute contains invalid int32 counter {field}')
    if value > (1 << 64) - (1 << 31):
        value -= 1 << 64  # negative int32 encoded as 10-byte varint
    if value < 0 or value > max_signed:
        raise ValueError(f'Health minute contains negative or invalid counter {field}')
    return value


def _health_double(row, field):
    """Proto3 omitted double values are zero; wire type must still be valid."""
    import math
    raw = _get(row, field, 1)
    value = 0.0 if raw is None else _double(raw)
    if not math.isfinite(value) or value < 0:
        raise ValueError(f'Health minute contains invalid statistic {field}')
    return value


def _health_minutes(root):
    """Decode HealthData.timeWindowStatistics, not an aggregate entity snapshot.

    Spark's HealthData stores WindowStatistics inside a protobuf map at field 2.
    Per-minute total entities and loaded chunks are timed fields, but *mob type*
    populations from PlatformStatistics.world are capture-wide snapshots only.
    """
    minutes = []
    for wire, raw in root.get(2, []):
        if wire != 2:
            raise ValueError('Invalid health minute map encoding')
        entry = _msg(raw)
        if 2 not in entry:
            raise ValueError('Health minute is missing WindowStatistics')
        row = _msg(_get(entry, 2, 2))
        start = _get(row, 11, 0)
        end = _get(row, 12, 0)
        if start is None or end is None or start <= 0 or end <= start:
            raise ValueError('Health minute lacks a valid UTC interval')
        if end - start > 5 * 60 * 1000:
            raise ValueError('Health minute interval is unexpectedly long')

        tps = _health_double(row, 4)
        median = _health_double(row, 5)
        maximum = _health_double(row, 6)
        if tps > 20.1 or maximum < median:
            raise ValueError('Health minute TPS/MSPT fields are inconsistent')
        minutes.append({
            'startUtc': _utc(start), 'endUtc': _utc(end),
            'ticks': _health_counter(row, 1), 'tps': tps,
            'medianMspt': median, 'maxTickMs': maximum,
            'players': _health_counter(row, 7), 'totalEntities': _health_counter(row, 8),
            'blockEntities': _health_counter(row, 9), 'loadedChunks': _health_counter(row, 10),
        })
        if len(minutes) > 10000:
            raise ValueError('Health minute history exceeds supported bound')
    minutes.sort(key=lambda row: row['startUtc'])
    for prior, following in zip(minutes, minutes[1:]):
        # Real Spark minute buckets can overlap by 1ms from sampling jitter.
        # Reject meaningful duplicated intervals, not boundary noise.
        end = datetime.fromisoformat(prior['endUtc'].replace('Z', '+00:00'))
        start = datetime.fromisoformat(following['startUtc'].replace('Z', '+00:00'))
        if (end - start).total_seconds() > 0.01:
            raise ValueError('Health minute history contains overlapping windows')
    return minutes


def read_capture(path):
    path = Path(path)
    size = path.stat().st_size
    if size < 1 or size > MAX_BYTES:
        raise ValueError(f'Input file must be 1..{MAX_BYTES} bytes')
    if path.suffix not in ('.sparkprofile', '.sparkhealth'):
        raise ValueError('Expected .sparkprofile or .sparkhealth')
    kind = 'profile' if path.suffix == '.sparkprofile' else 'health'
    root = _msg(memoryview(path.read_bytes()))
    kind, meta, world_data, stamp = _stats(root, kind)
    result = {'file': path.name, 'type': kind, 'capturedAtUtc': _utc(stamp) if stamp else None,
              'entities': _entities(world_data),
              'caveat': 'Entity/region counts are a capture-wide snapshot, NOT independently timed observations for each profile window.'}
    if kind == 'profile':
        result['startedAtUtc'] = _utc(_get(meta, 2, 0))
        result['finishedAtUtc'] = _utc(_get(meta, 11, 0)) if meta.get(11) else None
        result['totalTicks'] = _get(meta, 12, 0)
        # A tick-thresholded sampler has aggregate settings [metadata.aggregator[5]].
        aggregator = _msg(_get(meta, 5, 2)) if meta.get(5) else {}
        result['tickThresholdMs'] = round(_get(aggregator, 3, 0) / 1000, 3) if aggregator.get(3) else None
        result['windows'] = _windows(root, result['tickThresholdMs'] is not None)
        # Sum only qualified windows. Missing slowTicks is not equivalent to zero.
        result['qualifyingSlowTicksTotal'] = _get(aggregator, 4, 0) if result['tickThresholdMs'] is not None else None
        result['qualifyingSlowTicksInCompleteWindows'] = sum(w['slowTicks'] for w in result['windows'] if w['slowTicks'] is not None) if result['tickThresholdMs'] is not None else None
    else:
        result['healthMinuteHistory'] = _health_minutes(root)
    return result


def compare(before, after):
    b, a = before['entities'], after['entities']
    changed = []
    def check(label, x, y, minimum, ratio):
        if abs(y - x) > max(minimum, max(x, y) * ratio):
            changed.append({'metric': label, 'before': x, 'after': y})
    check('total entities', b['total'], a['total'], 200, .1)
    check('zombified piglins', b['mobs'].get('zombified_piglin', 0),
          a['mobs'].get('zombified_piglin', 0), 50, .1)
    check('largest entity region',
          b['largestRegions'][0]['entities'] if b['largestRegions'] else 0,
          a['largestRegions'][0]['entities'] if a['largestRegions'] else 0, 100, .1)
    return {'before': before['file'], 'after': after['file'],
            'entityLoadDifferences': changed,
            'note': 'Capture snapshots may be minutes apart; differences are confounders, not proven causes or timed per-window samples.'}


def markdown(capture, comparison=None):
    e = capture['entities']
    reg = e['largestRegions'][0] if e['largestRegions'] else None
    lines = [f"# Spark audit: {capture['file']}", '',
             f"Capture: {capture['capturedAtUtc']} | Type: {capture['type']}", '',
             f"- Entities: **{e['total']:,}**",
             f"- Zombified piglins: **{e['mobs'].get('zombified_piglin', 0):,}**",
             f"- Chunks containing entities: **{e['chunksWithEntities']:,}**",
             f"- Largest entity region: **{reg['entities']:,} entities** in **{reg['chunksWithEntities']} chunks** ({reg['world']})" if reg else '- No populated entity region', '']
    if reg and reg['entities'] >= 500:
        lines += [f"**INVESTIGATE ENTITY DENSITY:** {reg['entities']:,} entities concentrated in one region. This does not establish the cause of slow ticks.", '']
    if capture['type'] == 'profile':
        lines += ['| UTC window | TPS | Median MSPT | Max tick | Players | Ticks over threshold |',
                  '|---|---:|---:|---:|---:|---:|']
        for w in capture['windows']:
            def fmt(v, decimals=1):
                return f'{v:.{decimals}f}' if v is not None else 'n/a'
            lines.append(f"| {w['startUtc'] or 'unknown'} | {fmt(w['tps'],2)} | {fmt(w['medianMspt'])} ms | {fmt(w['maxTickMs'])} ms | {w['players'] if w['players'] is not None else 'n/a'} | {w['slowTicks'] if w['slowTicks'] is not None else 'n/a'} |")
        lines += ['']
    if capture['type'] == 'health' and capture.get('healthMinuteHistory'):
        minutes = capture['healthMinuteHistory']
        worst = min(minutes, key=lambda row: row['tps'])
        lines += [
            '## Recorded health history (minute windows)', '',
            f"**Worst recorded minute:** {worst['startUtc']} — TPS {worst['tps']:.2f}, "
            f"median MSPT {worst['medianMspt']:.1f} ms, worst tick {worst['maxTickMs']:.1f} ms.",
            '',
            '| UTC minute | TPS | Median MSPT | Worst tick | Players | Loaded chunks | Total entities | Block entities |',
            '|---|---:|---:|---:|---:|---:|---:|---:|',
        ]
        for row in minutes:
            lines.append(
                f"| {row['startUtc']} | {row['tps']:.2f} | "
                f"{row['medianMspt']:.1f} ms | {row['maxTickMs']:.1f} ms | "
                f"{row['players']} | {row['loadedChunks']} | {row['totalEntities']} | {row['blockEntities']} |"
            )
        lines += [
            '',
            '**Measurement limit:** per-minute entity totals and loaded chunks are timed, '
            'but the mob types and densest-region snapshot above are capture-wide. '
            'No per-minute piglin count, p95, or Java main-thread call-stack attribution '
            'is available from these minute rows.',
            '',
        ]
    if comparison:
        lines += ['## Differences between capture-wide snapshots', '']
        if comparison['entityLoadDifferences']:
            for x in comparison['entityLoadDifferences']:
                lines.append(f"- **{x['metric']}**: {x['before']:,} -> {x['after']:,}")
        else:
            lines.append('- No material entity difference exceeded the configured heuristic thresholds.')
        lines += ['', comparison['note'], '']
    lines += ['**Limit:** ' + capture['caveat']]
    return '\n'.join(lines) + '\n'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('capture', help='.sparkprofile or .sparkhealth file')
    p.add_argument('--compare', help='Optional earlier capture')
    p.add_argument('--json', action='store_true', help='Output JSON instead of Markdown')
    a = p.parse_args()
    current = read_capture(a.capture)
    diff = compare(read_capture(a.compare), current) if a.compare else None
    print(json.dumps({'capture': current, 'comparison': diff}, indent=2) if a.json
          else markdown(current, diff), end='')

if __name__ == '__main__':
    main()
