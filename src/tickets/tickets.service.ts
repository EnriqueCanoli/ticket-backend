import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Producto } from '../productos/entities/producto.entity';
import { Ticket } from './entities/ticket.entity';
import { TicketItem } from './entities/ticket-item.entity';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { TicketItemResponse, TicketResponse } from './interfaces/ticket-response.interface';

@Injectable()
export class TicketsService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Producto)
    private readonly productoRepository: Repository<Producto>,
  ) {}

  /**
   * ENDPOINTS.md sección 4, "Comportamiento del servidor":
   * 1. `usuarioId` viene del JWT (resuelto en el controller vía
   *    `@CurrentUser()`), nunca del body.
   * 2. Busca todos los `producto_id` de una sola vez, acotado al catálogo
   *    privado de `usuarioId` — un `producto_id` que existe pero pertenece a
   *    otro usuario se trata igual que uno inexistente (mismo `400`, no un
   *    caso nuevo). Si falta alguno, la request completa falla con `400`
   *    (no `404`) listando los que no se encontraron — no se crea un ticket
   *    parcial.
   * 3. Por cada línea, snapshotea `precio_venta_unitario`/`costo_unitario`
   *    del producto vigente y calcula `subtotal = cantidad * precio_venta_unitario`.
   * 4. `total = SUM(subtotal)`.
   * 5. Inserta `ticket` + `ticket_items` en una única transacción.
   */
  async create(dto: CreateTicketDto, usuarioId: string): Promise<TicketResponse> {
    const productoIds = dto.items.map((item) => item.producto_id);
    const uniqueProductoIds = [...new Set(productoIds)];

    const productos = await this.productoRepository.find({
      where: { id: In(uniqueProductoIds), usuarioId },
    });
    const productoById = new Map(productos.map((producto) => [producto.id, producto]));

    const missingIds = uniqueProductoIds.filter((id) => !productoById.has(id));
    if (missingIds.length > 0) {
      throw new BadRequestException(
        `Los siguientes producto_id no existen: ${missingIds.join(', ')}`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      // No se fusionan líneas con el mismo producto_id repetido (ENDPOINTS.md
      // §5.4): cada item del request produce su propia línea de ticket_items.
      const lineas = dto.items.map((item) => {
        const producto = productoById.get(item.producto_id)!;
        const precioVentaUnitario = producto.precioVenta;
        const costoUnitario = producto.costo;
        const subtotal = item.cantidad * precioVentaUnitario;
        return { item, producto, precioVentaUnitario, costoUnitario, subtotal };
      });

      const total = lineas.reduce((acc, linea) => acc + linea.subtotal, 0);

      const ticket = manager.create(Ticket, { usuarioId, total });
      await manager.save(ticket);

      const ticketItems = lineas.map((linea) =>
        manager.create(TicketItem, {
          ticketId: ticket.id,
          productoId: linea.item.producto_id,
          cantidad: linea.item.cantidad,
          precioVentaUnitario: linea.precioVentaUnitario,
          costoUnitario: linea.costoUnitario,
          subtotal: linea.subtotal,
        }),
      );
      await manager.save(ticketItems);

      const items: TicketItemResponse[] = lineas.map((linea, index) => ({
        id: ticketItems[index].id,
        producto_id: linea.item.producto_id,
        nombre_producto: linea.producto.nombre,
        cantidad: linea.item.cantidad,
        precio_venta_unitario: linea.precioVentaUnitario,
        costo_unitario: linea.costoUnitario,
        subtotal: linea.subtotal,
      }));

      return {
        id: ticket.id,
        usuario_id: ticket.usuarioId,
        total: ticket.total,
        created_at: ticket.createdAt,
        items,
      };
    });
  }
}
