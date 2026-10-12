import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import type {
  EstadoSuscripcionServidor,
  MotivoSuscripcion,
  TiendaSuscripcion,
} from '../interfaces/suscripcion-response.interface';

/**
 * Suscripción de una cuenta (1 a 1 con `usuarios`, UNIQUE `usuario_id`).
 * `estado` es el valor GUARDADO; el estado que ve el cliente y que decide el
 * bloqueo es el efectivo, calculado con `estadoEfectivo()` en cada lectura
 * (no hay proceso que actualice filas por el paso del tiempo). Los CHECK de
 * `estado`, `tienda` y `motivo` viven en la migración
 * CreateSuscripcionesTables (`synchronize: false`). La relación se declara
 * solo de este lado: `Usuario` no tiene inversa.
 */
@Entity('suscripciones')
export class Suscripcion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @OneToOne(() => Usuario, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  @Column({
    name: 'estado',
    type: 'varchar',
    length: 20,
    default: 'prueba',
  })
  estado: EstadoSuscripcionServidor;

  @Column({ name: 'prueba_inicio', type: 'timestamptz' })
  pruebaInicio: Date;

  /** 23:59:59 del día 14 contando el de inicio (zona de negocio). Nunca cambia al pagar. */
  @Column({ name: 'prueba_fin', type: 'timestamptz' })
  pruebaFin: Date;

  /** Fin del período pagado. */
  @Column({ name: 'acceso_hasta', type: 'timestamptz', nullable: true })
  accesoHasta: Date | null;

  @Column({ name: 'proximo_cobro', type: 'timestamptz', nullable: true })
  proximoCobro: Date | null;

  @Column({ name: 'renovacion_automatica', type: 'boolean', default: false })
  renovacionAutomatica: boolean;

  @Column({ name: 'tienda', type: 'varchar', length: 20, nullable: true })
  tienda: TiendaSuscripcion | null;

  @Column({ name: 'motivo', type: 'varchar', length: 20, nullable: true })
  motivo: MotivoSuscripcion | null;

  /** Momento del último cambio de `estado`. */
  @Column({ name: 'estado_desde', type: 'timestamptz', default: () => 'now()' })
  estadoDesde: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
