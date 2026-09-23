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
 * al consumirse. Solo puede haber un token vigente por usuario a la vez
 * (forgotPassword() borra cualquier token previo antes de crear uno nuevo).
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
