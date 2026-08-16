import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Usuario } from '../../usuarios/entities/usuario.entity';

/**
 * Refresh token opaco, persistido hasheado (SHA-256, no bcrypt — el valor ya
 * es aleatorio de alta entropía). Se rota en cada uso de POST /auth/refresh:
 * el usado queda marcado con `revokedAt` + `replacedById` apuntando al nuevo
 * emitido. Ver AUTH_ENDPOINTS.md sección 4.
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'usuario_id', type: 'uuid' })
  usuarioId: string;

  @ManyToOne(() => Usuario, (usuario) => usuario.refreshTokens, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'usuario_id' })
  usuario: Usuario;

  /** Hash SHA-256 (hex) del token opaco en claro. Nunca se persiste en claro. */
  @Column({ name: 'token_hash', type: 'varchar', length: 255, unique: true })
  tokenHash: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  /** `NULL` = vigente. Con valor = revocado (rotación o, a futuro, logout). */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'replaced_by_id', type: 'uuid', nullable: true })
  replacedById: string | null;

  /**
   * Autoreferencia: al rotar este token se apunta al nuevo emitido. Permite
   * detectar reuso de un token ya rotado (señal de robo) — ver
   * AUTH_ENDPOINTS.md sección 3, nota de seguridad de /auth/refresh.
   */
  @ManyToOne(() => RefreshToken, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'replaced_by_id' })
  replacedBy: RefreshToken | null;
}
