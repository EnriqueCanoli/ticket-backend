import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Suscripcion } from './entities/suscripcion.entity';
import { Compra } from './entities/compra.entity';
import { PagoHistorial } from './entities/pago-historial.entity';
import { EventoTienda } from './entities/evento-tienda.entity';
import { CompraSuscripcionService } from './compra-suscripcion.service';
import {
  CONFIG_SUSCRIPCION,
  leerConfigSuscripcion,
} from './config-suscripcion';
import type {
  ConfigSuscripcion,
  CredencialesGoogle,
} from './config-suscripcion';
import { CuentaOfuscadaService } from './cuenta-ofuscada';
import { SuscripcionesController } from './suscripciones.controller';
import { SuscripcionActivaGuard } from './guards/suscripcion-activa.guard';
import { SuscripcionesService } from './suscripciones.service';
import { VERIFICADOR_TIENDA } from './verificadores/verificador-tienda.interface';
import { VerificadorSimulado } from './verificadores/verificador-simulado';
import { VerificadorGoogle } from './verificadores/verificador-google';
import {
  GOOGLE_PLAY_API,
  GooglePlayApiReal,
} from './verificadores/google-play-api';
import type { GooglePlayApi } from './verificadores/google-play-api';
import { auth as googleAuth } from '@googleapis/androidpublisher';
import {
  FUENTE_ESTADO_GOOGLE,
  FuenteEstadoReal,
  FuenteEstadoSimulada,
} from './rtdn/fuente-estado-google';
import {
  VERIFICADOR_PUSH,
  VerificadorPushDesactivado,
  VerificadorPushOidc,
} from './rtdn/pubsub-auth';
import { ReconciliacionService } from './rtdn/reconciliacion.service';
import { RtdnController } from './rtdn/rtdn.controller';
import { RtdnService } from './rtdn/rtdn.service';

/**
 * Expone GET /me/suscripcion (etapa 2) y los POST de compra
 * `validar-compra` y `restaurar` (etapa 4a). No importa `AuthModule` a
 * propósito: `AuthModule` importa este módulo, y lo contrario crearía un
 * ciclo. El controller usa `JwtAuthGuard` y `CurrentUser` importándolos por
 * archivo, igual que `ProductosModule`. Exporta también
 * `SuscripcionActivaGuard` (etapa 3): los módulos de tickets y productos
 * importan este módulo y lo usan con `@UseGuards(JwtAuthGuard,
 * SuscripcionActivaGuard)`.
 *
 * `CONFIG_SUSCRIPCION` falla el arranque (fail-fast) con una configuración
 * inválida; `VERIFICADOR_TIENDA` es el simulado o el real de Google Play según
 * `VALIDACION_TIENDA` (etapa 4b). `CuentaOfuscadaService` (HMAC de
 * `cuenta_ofuscada`) se exporta para `GET /me`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Suscripcion,
      Compra,
      PagoHistorial,
      EventoTienda,
    ]),
  ],
  controllers: [SuscripcionesController, RtdnController],
  providers: [
    SuscripcionesService,
    SuscripcionActivaGuard,
    CompraSuscripcionService,
    CuentaOfuscadaService,
    RtdnService,
    ReconciliacionService,
    {
      provide: CONFIG_SUSCRIPCION,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const logger = new Logger('ConfigSuscripcion');
        const resultado = leerConfigSuscripcion({
          NODE_ENV: config.get<string>('NODE_ENV'),
          VALIDACION_TIENDA: config.get<string>('VALIDACION_TIENDA'),
          PRODUCTO_SUSCRIPCION_ID: config.get<string>(
            'PRODUCTO_SUSCRIPCION_ID',
          ),
          GOOGLE_SERVICE_ACCOUNT_JSON: config.get<string>(
            'GOOGLE_SERVICE_ACCOUNT_JSON',
          ),
          PLAY_PACKAGE_NAME: config.get<string>('PLAY_PACKAGE_NAME'),
          SUSCRIPCION_HMAC_SECRETO: config.get<string>(
            'SUSCRIPCION_HMAC_SECRETO',
          ),
          PUBSUB_PUSH_AUDIENCIA: config.get<string>('PUBSUB_PUSH_AUDIENCIA'),
          PUBSUB_PUSH_EMAIL: config.get<string>('PUBSUB_PUSH_EMAIL'),
        });
        if (!config.get<string>('VALIDACION_TIENDA')) {
          logger.warn(
            'VALIDACION_TIENDA no configurada: se usa el verificador simulado (solo desarrollo y pruebas)',
          );
        }
        if (!config.get<string>('SUSCRIPCION_HMAC_SECRETO')) {
          logger.warn(
            'SUSCRIPCION_HMAC_SECRETO no configurada: se usa un secreto de desarrollo (solo desarrollo y pruebas)',
          );
        }
        return resultado;
      },
    },
    {
      // Solo en modo google; en simulada es null (nunca se llama a Google).
      provide: GOOGLE_PLAY_API,
      inject: [CONFIG_SUSCRIPCION],
      useFactory: (config: ConfigSuscripcion): GooglePlayApi | null =>
        config.validacionTienda === 'google'
          ? new GooglePlayApiReal(
              config.paqueteAndroid as string,
              config.credencialesGoogle as CredencialesGoogle,
            )
          : null,
    },
    {
      provide: VERIFICADOR_TIENDA,
      inject: [CONFIG_SUSCRIPCION, GOOGLE_PLAY_API],
      useFactory: (config: ConfigSuscripcion, api: GooglePlayApi | null) =>
        config.validacionTienda === 'google' && api
          ? new VerificadorGoogle(api)
          : new VerificadorSimulado(),
    },
    {
      // Estado de la suscripción en la tienda para los avisos RTDN (etapa 5).
      provide: FUENTE_ESTADO_GOOGLE,
      inject: [CONFIG_SUSCRIPCION, GOOGLE_PLAY_API],
      useFactory: (config: ConfigSuscripcion, api: GooglePlayApi | null) =>
        config.validacionTienda === 'google' && api
          ? new FuenteEstadoReal(api)
          : new FuenteEstadoSimulada(),
    },
    {
      // Verificación del token OIDC del push de Pub/Sub (etapa 5, F10/F12).
      provide: VERIFICADOR_PUSH,
      inject: [CONFIG_SUSCRIPCION],
      useFactory: (config: ConfigSuscripcion) => {
        const logger = new Logger('RtdnPush');
        if (!config.rtdnVerificarOidc) {
          logger.warn(
            'Modo simulada: el endpoint RTDN NO verifica el token OIDC (solo desarrollo y pruebas con curl)',
          );
          return new VerificadorPushDesactivado();
        }
        if (config.pubsubAudiencia === null || config.pubsubEmail === null) {
          logger.warn(
            'PUBSUB_PUSH_AUDIENCIA o PUBSUB_PUSH_EMAIL no configuradas: el endpoint RTDN responderá 401 a todo',
          );
        }
        return new VerificadorPushOidc(
          config.pubsubAudiencia,
          config.pubsubEmail,
          new googleAuth.OAuth2(),
        );
      },
    },
  ],
  exports: [
    SuscripcionesService,
    SuscripcionActivaGuard,
    CuentaOfuscadaService,
    ReconciliacionService,
  ],
})
export class SuscripcionesModule {}
