import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';

/**
 * Código de 6 dígitos para restablecer contraseña, persistido hasheado
 * (SHA-256, mismo helper que refresh tokens). Uso único: se marca `usedAt`
 * al consumirse. Como máximo hay un token vigente (`usedAt IS NULL`) por
 * usuario en todo momento, garantizado en dos capas (BE-03):
 * - Aplicación: `forgotPassword()` borra cualquier token previo e inserta el
 *   nuevo dentro de una transacción con `SELECT ... FOR UPDATE` (lock:
 *   pessimistic_write) sobre la fila de `usuarios`, que serializa llamadas
 *   concurrentes al mismo usuario. Antes de este fix, el borrado+inserción
 *   no era atómico (dos statements sueltos, sin transacción ni lock) y
 *   peticiones concurrentes a `forgot-password` podían dejar 2+ filas
 *   vigentes simultáneas, todas válidas en `reset-password`.
 * - Base de datos: el índice único parcial
 *   `UQ_password_reset_tokens_usuario_id_vigente` (migración
 *   AddUniqueActivePasswordResetTokenPerUsuario) rechaza cualquier segunda
 *   fila vigente para el mismo `usuario_id`, como defensa en profundidad si
 *   algún camino futuro reintrodujera un check-then-act sin el lock de
 *   arriba.
 */
@Entity('password_reset_tokens')
export class PasswordResetToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @ManyToOne(() => Usuario, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  /** Hash SHA-256 (hex) del código de 6 dígitos en claro. Nunca se persiste en claro. */
  @Column({ name: 'code_hash', type: 'varchar', length: 255 })
  codeHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** `NULL` = vigente. Con valor = ya consumido (uso único). */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt: Date | null;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;
}
