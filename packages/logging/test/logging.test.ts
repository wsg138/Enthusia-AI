import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/index.js';

class CaptureStream extends Writable {
  lines: string[] = [];

  _write(chunk: unknown, _encoding: string, callback: () => void): void {
    this.lines.push(String(chunk));
    callback();
  }

  parsed(): Array<Record<string, unknown>> {
    return this.lines
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe('createLogger', () => {
  it('emits structured JSON lines with name and level', () => {
    const stream = new CaptureStream();
    const logger = createLogger({ name: 'test-service', stream });
    logger.info({ requestId: 'r-1' }, 'hello');
    const [line] = stream.parsed();
    expect(line?.['name']).toBe('test-service');
    expect(line?.['level']).toBe(30);
    expect(line?.['msg']).toBe('hello');
    expect(line?.['requestId']).toBe('r-1');
    expect(typeof line?.['time']).toBe('string');
  });

  it('supports message-only calls', () => {
    const stream = new CaptureStream();
    const logger = createLogger({ name: 'test-service', stream });
    logger.warn('just a message');
    const [line] = stream.parsed();
    expect(line?.['msg']).toBe('just a message');
    expect(line?.['level']).toBe(40);
  });

  it('propagates traceId via withTraceId', () => {
    const stream = new CaptureStream();
    const logger = createLogger({ name: 'test-service', stream });
    logger.withTraceId('trace-123').error('boom');
    const [line] = stream.parsed();
    expect(line?.['traceId']).toBe('trace-123');
    expect(line?.['level']).toBe(50);
  });

  it('child loggers bind extra fields', () => {
    const stream = new CaptureStream();
    const logger = createLogger({ name: 'test-service', stream });
    logger.child({ component: 'tool-gateway' }).info('hi');
    const [line] = stream.parsed();
    expect(line?.['component']).toBe('tool-gateway');
  });

  it('respects the configured level', () => {
    const stream = new CaptureStream();
    const logger = createLogger({ name: 'test-service', level: 'warn', stream });
    logger.info('suppressed');
    logger.error('visible');
    const lines = stream.parsed();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.['msg']).toBe('visible');
  });
});
