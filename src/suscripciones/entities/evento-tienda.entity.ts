import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import { Compra } from './compra.entity';
import type { TiendaSuscripcion } from '../interfaces/suscripcion-response.interface';

/**
 * Bitácora idempotente de las notificaciones de la tienda (RTDN). UNIQUE
 * `message_id` (el `messageId` de Pub/Sub). `usuario_id` y `compra_id` son
 * opcionales (un evento puede llegar sin que se conozca la compra) y pasan a
 * NULL si se borra la fila referenciada. Sin uso hasta la etapa 5.
 */
@Entity('eventos_tienda')
export class EventoTienda {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'tienda',
    type: 'varchar',
    length: 20,
    default: 'google_play',
  })
  tienda: TiendaSuscripcion;

  @Column({ name: 'message_id', type: 'varchar', length: 100 })
  messageId: string;

  @Column({ name: 'tipo', type: 'varchar', length: 60, nullable: true })
  tipo: string | null;

  @Column({ name: 'payload', type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'usuario_id', type: 'uuid', nullable: true })
  usuarioId: string | null;

  @ManyToOne(() => Usuario, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario | null;

  @Column({ name: 'compra_id', type: 'uuid', nullable: true })
  compraId: string | null;

  @ManyToOne(() => Compra, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'compra_id' })
  compra: Compra | null;

  @Column({ name: 'recibido_en', type: 'timestamptz', default: () => 'now()' })
  recibidoEn: Date;

  /** `NULL` = recibido pero no procesado. */
  @Column({ name: 'procesado_en', type: 'timestamptz', nullable: true })
  procesadoEn: Date | null;

  @Column({ name: 'resultado', type: 'varchar', length: 40, nullable: true })
  resultado: string | null;

  @Column({ name: 'error', type: 'text', nullable: true })
  error: string | null;
}
