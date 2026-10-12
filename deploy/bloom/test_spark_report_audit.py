"""Synthetic contract tests; no proprietary server captures or credentials needed."""
import tempfile
import unittest
from pathlib import Path
import struct
from spark_report_audit import read_capture, compare, markdown


def varint(num):
    output = bytearray()
    while num > 127:
        output.append((num & 127) | 128)
        num >>= 7
    output.append(num)
    return bytes(output)


def v(field, number):
    return varint(field << 3) + varint(number)


def msg(field, data):
    return varint((field << 3) | 2) + varint(len(data)) + data


def dbl(field, number):
    return varint((field << 3) | 1) + struct.pack('<d', number)


def snapshot(piglins=1637, total=1800, region_size=1700):
    mob = msg(1, b'zombified_piglin') + v(2, piglins)
    chunk = v(3, region_size) + msg(4, mob)
    region = v(1, region_size) + msg(2, chunk)
    world = msg(1, b'world') + v(2, total) + msg(3, region)
    worldstats = v(1, total) + msg(2, mob) + msg(3, world)
    return msg(8, worldstats)


def sparkprofile(piglins=1637, total=1800, region_size=1700, threshold=True):
    metadata = v(2, 1791756544569) + v(11, 1791756784726) + v(12, 3586)
    metadata += msg(5, v(3, 100000) + v(4, 316) if threshold else v(2, 1))
    metadata += msg(8, snapshot(piglins, total, region_size))
    metrics = v(1, 236) + dbl(4, 11.88) + dbl(5, 59.2) + dbl(6, 371.8) + v(7, 21)
    metrics += v(11, 1791756617001) + v(12, 1791756677001)
    window = v(1, 29862610) + msg(2, metrics)
    return msg(1, metadata) + msg(7, window)


def sparkhealth(piglins=1637, total=1800, region_size=1700):
    health = msg(3, snapshot(piglins, total, region_size)) + v(5, 1791758279096)
    return msg(1, health)


def minute_window(start, tps, median_mspt, worst_tick_ms, players=23,
                  entities=2903, chunks=10380):
    return (v(1, 1200) + dbl(4, tps) + dbl(5, median_mspt)
            + dbl(6, worst_tick_ms) + v(7, players)
            + v(8, entities) + v(9, 7900) + v(10, chunks)
            + v(11, start) + v(12, start + 60000))


def health_history():
    first = 1791756600000
    return (sparkhealth(601, 2903, 258)
            + msg(2, v(1, 0) + msg(2, minute_window(
                first, 13.1, 84.0, 522.0)))
            + msg(2, v(1, 1) + msg(2, minute_window(
                first + 60000, 20.0, 31.9, 110.8, players=19,
                entities=2300, chunks=9000))))


class SparkAuditTests(unittest.TestCase):
    def capture(self, content, suffix):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        name = Path(root.name) / ('synthetic' + suffix)
        name.write_bytes(content)
        return read_capture(name)

    def test_reads_profile_entities_region_and_timing(self):
        c = self.capture(sparkprofile(), '.sparkprofile')
        self.assertEqual(c['entities']['total'], 1800)
        self.assertEqual(c['entities']['mobs']['zombified_piglin'], 1637)
        self.assertEqual(c['entities']['largestRegions'][0]['entities'], 1700)
        self.assertEqual(c['entities']['largestRegions'][0]['topMobs']['zombified_piglin'], 1637)
        self.assertEqual(c['entities']['chunksWithEntities'], 1)
        self.assertEqual(c['qualifyingSlowTicksTotal'], 316)
        self.assertEqual(c['qualifyingSlowTicksInCompleteWindows'], 236)
        self.assertEqual(c['tickThresholdMs'], 100)
        self.assertAlmostEqual(c['windows'][0]['tps'], 11.88)

    def test_ordinary_sampler_tick_count_not_called_slow_ticks(self):
        c = self.capture(sparkprofile(threshold=False), '.sparkprofile')
        self.assertIsNone(c['tickThresholdMs'])
        self.assertIsNone(c['qualifyingSlowTicksTotal'])
        self.assertIsNone(c['windows'][0]['slowTicks'])

    def test_health_uses_different_wrapper_without_fabricating_windows(self):
        c = self.capture(sparkhealth(0, 100, 50), '.sparkhealth')
        self.assertEqual(c['type'], 'health')
        self.assertEqual(c['entities']['total'], 100)
        self.assertNotIn('windows', c)

    def test_health_minute_history_preserves_tps_spikes_and_timed_load(self):
        c = self.capture(health_history(), '.sparkhealth')
        self.assertEqual(c['type'], 'health')
        self.assertEqual(len(c['healthMinuteHistory']), 2)
        slow, recovered = c['healthMinuteHistory']
        self.assertAlmostEqual(slow['tps'], 13.1)
        self.assertAlmostEqual(slow['medianMspt'], 84.0)
        self.assertAlmostEqual(slow['maxTickMs'], 522.0)
        self.assertEqual(slow['totalEntities'], 2903)
        self.assertEqual(slow['loadedChunks'], 10380)
        self.assertEqual(recovered['players'], 19)
        self.assertEqual(recovered['loadedChunks'], 9000)
        self.assertEqual(c['entities']['mobs']['zombified_piglin'], 601)
        text = markdown(c)
        self.assertIn('Worst recorded minute', text)
        self.assertIn('13.10', text)
        self.assertIn('No per-minute piglin count', text)
        self.assertNotIn('| UTC window |', text)

    def test_malformed_health_minute_cannot_pretend_it_is_valid(self):
        bad_row = v(11, 1791756600000) + v(12, 1791756660000)
        malformed = sparkhealth() + msg(2, v(1, 0) + msg(2, bad_row))
        with self.assertRaisesRegex(ValueError, 'missing floating point'):
            self.capture(malformed, '.sparkhealth')

    def test_health_minutes_with_overlapping_windows_fail_closed(self):
        original = health_history()
        first = 1791756600000
        overlap = msg(2, v(1, 2) + msg(2, minute_window(
            first + 30000, 19.9, 20.1, 43.2)))
        with self.assertRaisesRegex(ValueError, 'overlapping windows'):
            self.capture(original + overlap, '.sparkhealth')

    def test_alerts_on_piglin_farm_difference(self):
        before = self.capture(sparkprofile(0, 100, 50), '.sparkprofile')
        after = self.capture(sparkprofile(), '.sparkprofile')
        delta = compare(before, after)
        metrics = {item['metric'] for item in delta['entityLoadDifferences']}
        self.assertEqual(metrics, {'total entities', 'zombified piglins', 'largest entity region'})
        self.assertIn('INVESTIGATE ENTITY DENSITY', markdown(after, delta))

    def test_corruption_does_not_silently_pass(self):
        with self.assertRaises(ValueError):
            self.capture(b'\x0a\x7fabc', '.sparkhealth')

    def test_no_pretend_profiling_when_only_health_supplied(self):
        c = self.capture(sparkhealth(), '.sparkhealth')
        text = markdown(c)
        self.assertNotIn('| UTC window |', text)
        self.assertIn('capture-wide snapshot', text)


if __name__ == '__main__':
    unittest.main()
