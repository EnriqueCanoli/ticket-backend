import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/main';

/**
 * BE-05: la app no tenía un límite explícito de tamaño de body — dependía
 * del default implícito de body-parser (100kb), y ese default solo se
 * aplicaba cuando el `Content-Type` matcheaba `application/json`/
 * `application/x-www-form-urlencoded`; con un `Content-Type` ausente o
 * distinto, un body de cualquier tamaño se saltaba el chequeo por completo
 * (confirmado con reproducción real contra el backend corriendo, no solo
 * lectura de código).
 *
 * Importante: a diferencia de `test/app.e2e-spec.ts` (que arma la app con
 * `Test.createTestingModule({ imports: [AppModule] }).compile()` +
 * `createNestApplication()` + `app.init()`, SIN pasar nunca por
 * `bootstrap()`), este test arma la app con `NestFactory.create()` +
 * `configureApp()` — la misma función que usa `src/main.ts` — para probar
 * de verdad el límite y los filtros que corren en producción/desarrollo, no
 * el bodyParser default de Nest.
 *
 * Usa el AppModule real (Postgres real, como el resto de los `*.e2e-spec.ts`
 * de este repo) porque el rechazo por tamaño ocurre en el middleware de
 * body-parser, antes de que la request llegue a un controller o toque la
 * base de datos — no hace falta mockear nada para estos casos.
 */
describe('Límite de tamaño de body (BE-05, e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: false,
    });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const bigEmailBody = (mb: number) =>
    JSON.stringify({ email: 'a'.repeat(mb * 1024 * 1024) + '@example.com' });

  it('un body JSON >1MB con Content-Type: application/json responde 413 con formato consistente con el resto de la API', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .send(bigEmailBody(2));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      statusCode: 413,
      message: 'request entity too large',
      error: 'Payload Too Large',
    });
  });

  it('un body pequeño normal sigue respondiendo su 4xx/2xx habitual (ValidationPipe intacto)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .send({ email: 'no-es-un-correo' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      message: ['Ingresa un correo válido'],
      error: 'Bad Request',
      statusCode: 400,
    });
  });

  it('el proceso sigue vivo y respondiendo después del body grande (segunda request exitosa)', async () => {
    const res = await request(app.getHttpServer()).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toBe('Hello World!');
  });

  it('un body >1MB con Content-Type ausente también responde 413 (no se salta el límite)', async () => {
    // Pasar un Buffer (no un string/objeto plano) a `.send()` es la forma de
    // que supertest/superagent NO fuerce un Content-Type por su cuenta (ver
    // `_isHost` en superagent): así la request sale sin encabezado
    // Content-Type, replicando el caso real reproducido a mano contra el
    // backend corriendo.
    const res = await request(app.getHttpServer() as App)
      .post('/auth/forgot-password')
      .send(Buffer.from(bigEmailBody(2)));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      statusCode: 413,
      message: 'request entity too large',
      error: 'Payload Too Large',
    });
  });

  it('un body >1MB con Content-Type distinto (text/plain) también responde 413 (no se salta el límite)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/auth/forgot-password')
      .set('Content-Type', 'text/plain')
      .send(bigEmailBody(2));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      statusCode: 413,
      message: 'request entity too large',
      error: 'Payload Too Large',
    });
  });
});
