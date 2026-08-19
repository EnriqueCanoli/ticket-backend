import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Producto } from '../../productos/entities/producto.entity';
import { numericTransformer } from '../../database/transformers/numeric.transformer';
import { Ticket } from './ticket.entity';

@Entity('ticket_items')
export class TicketItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'ticket_id', type: 'uuid' })
  ticketId: string;

  @ManyToOne(() => Ticket, (ticket) => ticket.ticketItems, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;

  @Column({ name: 'producto_id', type: 'uuid' })
  productoId: string;

  @ManyToOne(() => Producto, (producto) => producto.ticketItems, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'producto_id' })
  producto: Producto;

  /**
   * Permite decimales (ventas por peso). numeric(10,3) da margen a
   * fracciones más finas que las que hoy usa el frontend. README 3.4.
   */
  @Column({
    name: 'cantidad',
    type: 'numeric',
    precision: 10,
    scale: 3,
    transformer: numericTransformer,
  })
  cantidad: number;

  /** Snapshot de productos.precio_venta al momento de vender. */
  @Column({
    name: 'precio_venta_unitario',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  precioVentaUnitario: number;

  /** Snapshot de productos.costo al momento de vender. */
  @Column({
    name: 'costo_unitario',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  costoUnitario: number;

  /** Igual a cantidad * precio_venta_unitario. Ver README 3.4. */
  @Column({
    name: 'subtotal',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  subtotal: number;
}
