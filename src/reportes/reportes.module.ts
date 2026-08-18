import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketItem } from '../tickets/entities/ticket-item.entity';
import { Producto } from '../productos/entities/producto.entity';
import { ReportesService } from './reportes.service';
import { ReportesController } from './reportes.controller';

@Module({
  // Ticket/Producto se registran junto con TicketItem porque ambos endpoints
  // hacen JOIN contra las 3 tablas (features/vendido/ENDPOINTS.md secciones 2
  // y 3), aunque el service solo inyecta el repositorio de TicketItem y
  // recorre las relaciones vía QueryBuilder (`ti.ticket`, `ti.producto`).
  imports: [TypeOrmModule.forFeature([Ticket, TicketItem, Producto])],
  controllers: [ReportesController],
  providers: [ReportesService],
})
export class ReportesModule {}
