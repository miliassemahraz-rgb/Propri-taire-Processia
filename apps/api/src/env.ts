import { loadEnv, type Env } from '@processia/config/env';

export const ENV = Symbol('ENV');

export const envProvider = {
  provide: ENV,
  useFactory: (): Env => loadEnv(),
};
