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
import { SuscripcionesController } from './suscripciones.controller';
import { SuscripcionActivaGuard } from './guards/suscripcion-activa.guard';
import { SuscripcionesService } from './suscripciones.service';
import { VERIFICADOR_TIENDA } from './verificadores/verificador-tienda.interface';
import { VerificadorSimulado } from './verificadores/verificador-simulado';

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
 * inválida; `VERIFICADOR_TIENDA` es hoy solo el simulado (la rama `google`
 * llega en la etapa 4b).
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
  controllers: [SuscripcionesController],
  providers: [
    SuscripcionesService,
    SuscripcionActivaGuard,
    CompraSuscripcionService,
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
        });
        if (!config.get<string>('VALIDACION_TIENDA')) {
          logger.warn(
            'VALIDACION_TIENDA no configurada: se usa el verificador simulado (solo desarrollo y pruebas)',
          );
        }
        return resultado;
      },
    },
    {
      provide: VERIFICADOR_TIENDA,
      inject: [CONFIG_SUSCRIPCION],
      // La etapa 4b añadirá la rama 'google'.
      useFactory: () => new VerificadorSimulado(),
    },
  ],
  exports: [SuscripcionesService, SuscripcionActivaGuard],
})
export class SuscripcionesModule {}
