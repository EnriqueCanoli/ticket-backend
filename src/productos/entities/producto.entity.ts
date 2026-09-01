import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { numericTransformer } from '../../database/transformers/numeric.transformer';
import { TicketItem } from '../../tickets/entities/ticket-item.entity';

@Entity('productos')
export class Producto {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Catálogo privado por cuenta: cada usuario tiene su propio catálogo de
   * productos, sin mezclarse con el de otras cuentas. Mismo patrón que
   * `Ticket.usuarioId`/`Ticket.usuario` (ver `ticket.entity.ts`).
   */
  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @ManyToOne(() => Usuario, (usuario) => usuario.productos, { nullable: false })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  @Column({ name: 'nombre', type: 'varchar', length: 150 })
  nombre: string;

  /**
   * Default `1` (no `0`) a propósito: reproduce el alta rápida de producto
   * desde el buscador de ticket, que no captura costo. Ver README 3.2.
   */
  @Column({
    name: 'costo',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 1,
    transformer: numericTransformer,
  })
  costo: number;

  @Column({
    name: 'precio_venta',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  precioVenta: number;

  @Column({ name: 'costo_validado', type: 'boolean', default: true })
  costoValidado: boolean;

  @Column({ name: 'es_a_granel', type: 'boolean', default: false })
  esAGranel: boolean;

  /**
   * Soft-delete flag (ENDPOINTS.md §6): `true` = visible en catálogo y
   * búsquedas; `false` = "borrado" para el cliente, pero la fila persiste
   * para no violar `ticket_items.producto_id ... ON DELETE RESTRICT`.
   */
  @Column({ name: 'activo', type: 'boolean', default: true })
  activo: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => TicketItem, (ticketItem) => ticketItem.producto)
  ticketItems: TicketItem[];
}
