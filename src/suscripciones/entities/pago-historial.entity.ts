import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { numericTransformer } from '../../database/transformers/numeric.transformer';
import { Compra } from './compra.entity';
import type {
  EstadoPagoHistorial,
  TiendaSuscripcion,
} from '../interfaces/suscripcion-response.interface';

/**
 * Un cobro de la suscripción. UNIQUE por (`tienda`, `external_id`);
 * `external_id` es el `id` que ve el cliente. `periodo` (`YYYY-MM`) es el mes
 * de `cobrado_en` en la zona de negocio (`periodoNegocio()`). Los CHECK viven
 * en la migración.
 */
@Entity('pagos_historial')
export class PagoHistorial {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @ManyToOne(() => Usuario, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  @Column({ name: 'compra_id', type: 'uuid', nullable: true })
  compraId: string | null;

  @ManyToOne(() => Compra, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'compra_id' })
  compra: Compra | null;

  @Column({ name: 'tienda', type: 'varchar', length: 20 })
  tienda: TiendaSuscripcion;

  @Column({ name: 'external_id', type: 'varchar', length: 100 })
  externalId: string;

  @Column({ name: 'periodo', type: 'char', length: 7 })
  periodo: string;

  @Column({ name: 'cobrado_en', type: 'timestamptz' })
  cobradoEn: Date;

  @Column({
    name: 'monto',
    type: 'numeric',
    precision: 10,
    scale: 2,
    transformer: numericTransformer,
  })
  monto: number;

  @Column({ name: 'moneda', type: 'char', length: 3, default: 'MXN' })
  moneda: string;

  @Column({ name: 'estado', type: 'varchar', length: 20 })
  estado: EstadoPagoHistorial;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
