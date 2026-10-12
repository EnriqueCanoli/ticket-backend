import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { Suscripcion } from './suscripcion.entity';
import type { TiendaSuscripcion } from '../interfaces/suscripcion-response.interface';

export type EstadoCompra =
  'pendiente' | 'confirmada' | 'reembolsada' | 'expirada';

/**
 * Compra (suscripción de la tienda) ligada a una cuenta. UNIQUE por
 * (`tienda`, `purchase_token`): base de la deduplicación. Un mismo token se
 * mantiene en las renovaciones, así que hay una fila por suscripción de la
 * tienda y varias de `pagos_historial`. Los CHECK viven en la migración.
 */
@Entity('compras')
export class Compra {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @ManyToOne(() => Usuario, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  @Column({ name: 'suscripcion_id', type: 'uuid' })
  suscripcionId: string;

  @ManyToOne(() => Suscripcion, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'suscripcion_id' })
  suscripcion: Suscripcion;

  @Column({ name: 'tienda', type: 'varchar', length: 20 })
  tienda: TiendaSuscripcion;

  @Column({ name: 'producto_id', type: 'varchar', length: 100 })
  productoId: string;

  @Column({ name: 'purchase_token', type: 'text' })
  purchaseToken: string;

  @Column({ name: 'order_id', type: 'varchar', length: 100, nullable: true })
  orderId: string | null;

  @Column({
    name: 'estado',
    type: 'varchar',
    length: 20,
    default: 'pendiente',
  })
  estado: EstadoCompra;

  @Column({ name: 'periodo_inicio', type: 'timestamptz', nullable: true })
  periodoInicio: Date | null;

  @Column({ name: 'periodo_fin', type: 'timestamptz', nullable: true })
  periodoFin: Date | null;

  /** Momento del acknowledge; `NULL` = pendiente de reconocer. */
  @Column({ name: 'reconocida_en', type: 'timestamptz', nullable: true })
  reconocidaEn: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
