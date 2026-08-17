import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from './entities/ticket.entity';
import { TicketItem } from './entities/ticket-item.entity';
import { Producto } from '../productos/entities/producto.entity';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';

@Module({
  // Producto se incluye para el lookup de precio/costo vigente y del
  // nombre en la respuesta (ENDPOINTS.md sección 4).
  imports: [TypeOrmModule.forFeature([Ticket, TicketItem, Producto])],
  controllers: [TicketsController],
  providers: [TicketsService],
})
export class TicketsModule {}
