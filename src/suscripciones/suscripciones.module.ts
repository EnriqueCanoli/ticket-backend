import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Suscripcion } from './entities/suscripcion.entity';
import { Compra } from './entities/compra.entity';
import { PagoHistorial } from './entities/pago-historial.entity';
import { EventoTienda } from './entities/evento-tienda.entity';
import { SuscripcionesController } from './suscripciones.controller';
import { SuscripcionesService } from './suscripciones.service';

/**
 * Expone GET /me/suscripcion (etapa 2). No importa `AuthModule` a propósito:
 * `AuthModule` importa este módulo, y lo contrario crearía un ciclo. El
 * controller usa `JwtAuthGuard` y `CurrentUser` importándolos por archivo,
 * igual que `ProductosModule`.
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
  providers: [SuscripcionesService],
  exports: [SuscripcionesService],
})
export class SuscripcionesModule {}
