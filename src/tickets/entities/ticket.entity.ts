import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { numericTransformer } from '../../database/transformers/numeric.transformer';
import { TicketItem } from './ticket-item.entity';

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @ManyToOne(() => Usuario, (usuario) => usuario.tickets, { nullable: false })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  /**
   * Denormalizado a propósito (suma de ticket_items.subtotal). El ticket es
   * inmutable una vez guardado (no hay pantalla de edición) — ver README
   * sección 5, punto 3. El backend debe calcularlo y persistirlo al INSERT,
   * nunca recibirlo del cliente como dato de confianza.
   */
  @Column({
    name: 'total',
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: numericTransformer,
  })
  total: number;

  /**
   * Solo `created_at`: el ticket es inmutable, no existe pantalla de
   * edición sobre un ticket ya guardado (README sección 1 y 3.3).
   */
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => TicketItem, (ticketItem) => ticketItem.ticket)
  ticketItems: TicketItem[];
}
