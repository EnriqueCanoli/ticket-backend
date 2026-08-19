import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Producto } from './entities/producto.entity';
import { TicketItem } from '../tickets/entities/ticket-item.entity';
import { ProductosService } from './productos.service';
import { ProductosController } from './productos.controller';

@Module({
  imports: [
    // TicketItem se registra porque `ProductosService.update` corrige
    // retroactivamente `ticket_items.costo_unitario` en la primera confirmación
    // de costo (vía el EntityManager de la transacción).
    TypeOrmModule.forFeature([Producto, TicketItem]),
  ],
  controllers: [ProductosController],
  providers: [ProductosService],
  exports: [ProductosService],
})
export class ProductosModule {}
