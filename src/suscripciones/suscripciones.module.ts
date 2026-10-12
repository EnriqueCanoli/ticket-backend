import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Suscripcion } from './entities/suscripcion.entity';
import { Compra } from './entities/compra.entity';
import { PagoHistorial } from './entities/pago-historial.entity';
import { EventoTienda } from './entities/evento-tienda.entity';
import { SuscripcionesService } from './suscripciones.service';

/**
 * Sin controller todavía (los endpoints llegan en la etapa 2). No importa
 * `AuthModule` a propósito: `AuthModule` importa este módulo, y lo contrario
 * crearía un ciclo.
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
  providers: [SuscripcionesService],
  exports: [SuscripcionesService],
})
export class SuscripcionesModule {}
