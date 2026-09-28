import * as http from 'node:http';
import { ArgumentsHost, ValidationPipe } from '@nestjs/common';
import {
  AbstractHttpAdapter,
  BaseExceptionFilter,
  NestFactory,
} from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

// BE-05: límite explícito de tamaño de body. No hay que depender del default
// implícito de body-parser (100kb) ni de que alguien lo cambie sin darse
// cuenta: los DTOs actuales (auth, productos, tickets) son formularios chicos
// sin subida de archivos, así que 1 MB es generoso y deja margen.
const BODY_LIMIT = '1mb';

/**
 * Normaliza a 413/415/etc. con el mismo formato que el resto de los 4xx de
 * esta API (`{statusCode, message, error}`).
 *
 * Nest reenvía a este filtro cualquier error con `statusCode` + `message`
 * que NO sea una `HttpException` propia — en particular los que lanza
 * body-parser/raw-body como middleware de Express (ej. "request entity too
 * large" al superar `BODY_LIMIT`). Nest ya traduce especialmente el
 * `SyntaxError` de JSON inválido a un `BadRequestException` (ver
 * `mapExternalException` en `@nestjs/core/router/routes-resolver.js`), pero
 * cualquier otro error "http-errors" (413, 415, etc.) cae al fallback
 * genérico de `BaseExceptionFilter.handleUnknownError` y responde
 * `{statusCode, message}` SIN el campo `error` que sí llevan
 * `ValidationPipe`/`BadRequestException`. Confirmado con una request real de
 * >1MB antes de este fix: devolvía
 * `{"statusCode":413,"message":"request entity too large"}` sin `"error"`.
 * Este filtro solo cubre ese caso puntual (delega todo lo demás al
 * comportamiento default de Nest sin tocarlo).
 */
class HttpErrorsFilter extends BaseExceptionFilter {
  override handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: AbstractHttpAdapter,
  ): void {
    if (!this.isHttpError(exception)) {
      super.handleUnknownError(exception, host, applicationRef);
      return;
    }
    const response: unknown = host.getArgByIndex(1);
    const body = {
      statusCode: exception.statusCode,
      message: exception.message,
      error: http.STATUS_CODES[exception.statusCode] ?? 'Error',
    };
    if (!applicationRef.isHeadersSent(response)) {
      applicationRef.reply(response, body, body.statusCode);
    } else {
      applicationRef.end(response);
    }
  }
}

/**
 * Configuración real de la app (pipes, filtros y bodyParser), extraída de
 * `bootstrap()` para poder reusarla en tests e2e: `test/app.e2e-spec.ts` (y
 * el resto de los `*.e2e-spec.ts` existentes) arman la app con
 * `Test.createTestingModule({ imports: [AppModule] }).compile()` +
 * `createNestApplication()` + `app.init()`, que NUNCA pasa por esta función
 * ni por `bootstrap()` — solo levanta el bodyParser default de Nest (100kb,
 * sin `ValidationPipe`). Un test de BE-05 escrito contra ese patrón no
 * probaría nada de lo de acá abajo.
 */
export function configureApp(app: NestExpressApplication): void {
  // AUTH_ENDPOINTS.md sección 1: 400 con `message` como arreglo de strings
  // por campo cuando la validación de un DTO falla.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new HttpErrorsFilter(app.getHttpAdapter()));

  // BE-05 — límite explícito de tamaño de body, en vez de depender del
  // default implícito de body-parser. `useBodyParser('json'/'urlencoded', …)`
  // solo se activa cuando el Content-Type matchea 'application/json' /
  // 'application/x-www-form-urlencoded': un Content-Type ausente o distinto
  // se salta el parseo Y el límite por completo (comprobado con reproducción
  // real — ver informe: un body de 1MB con Content-Type ausente o
  // "text/plain" nunca disparaba el chequeo de tamaño). Por eso agregamos un
  // tercer parser "catch-all" con `type: () => true` registrado después: si
  // el body ya fue consumido por json()/urlencoded() no hace nada (el stream
  // ya está "finished", ver body-parser/lib/read.js), pero si el Content-Type
  // real no matcheó ninguno de los dos anteriores, este sí lee el body
  // completo y aplica el mismo límite. No usamos su resultado (no queremos
  // pisar req.body con un Buffer): el middleware siguiente lo revierte a
  // `undefined` para no romper el DTO binding de ValidationPipe, que ya
  // rechaza con 400 cualquier request sin Content-Type/body reconocible.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  app.useBodyParser('raw', { limit: BODY_LIMIT, type: () => true });
  app.use((req: { body?: unknown }, _res: unknown, next: () => void) => {
    if (Buffer.isBuffer(req.body)) {
      req.body = undefined;
    }
    next();
  });
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
