import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv(); // fail fast on bad configuration
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api/v1');
  if (env.TRUST_PROXY > 0) app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.enableCors({ origin: env.WEB_URL, credentials: false });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
}

bootstrap().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
