import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { numericTransformer } from '../../database/transformers/numeric.transformer';
import { TicketItem } from '../../tickets/entities/ticket-item.entity';

@Entity('productos')
export class Producto {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => TicketItem, (ticketItem) => ticketItem.producto)
  ticketItems: TicketItem[];
}
