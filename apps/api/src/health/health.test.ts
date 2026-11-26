import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

const up = { check: () => Promise.resolve() };
const down = { check: () => Promise.reject(new Error('indisponible')) };

describe('GET /health', () => {
  it('renvoie db ok et s3 ok quand tout répond', async () => {
    const controller = new HealthController(new HealthService(up, up));
    await expect(controller.get()).resolves.toEqual({ db: 'ok', s3: 'ok' });
  });

  it('renvoie 503 en nommant la dépendance en échec', async () => {
    const controller = new HealthController(new HealthService(up, down));
    const error = await controller.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toEqual({ db: 'ok', s3: 'error' });
  });
});
