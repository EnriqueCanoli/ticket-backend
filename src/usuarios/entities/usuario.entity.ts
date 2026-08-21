import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Ticket } from '../../tickets/entities/ticket.entity';
import { Producto } from '../../productos/entities/producto.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';

@Entity('usuarios')
export class Usuario {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Sin `unique` aquí: la unicidad real la garantiza el índice funcional
   * `UQ_usuarios_email_lower` sobre `LOWER(email)` (ver migración
   * NormalizeUsuariosEmail), no este decorador — el proyecto usa
   * `synchronize: false`, así que TypeORM nunca sincroniza constraints desde
   * las entidades.
   */
  @Column({ name: 'email', type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  /**
   * A diferencia de `email` (unicidad vía índice funcional sobre
   * `LOWER(email)`, que este decorador no puede expresar), `phone` se mapea
   * 1 a 1 con un `UNIQUE` simple sobre la columna tal cual
   * (`UQ_usuarios_phone`, ver migración AddUniquePhoneToUsuarios), así que el
   * decorador sí documenta correctamente la restricción real. Con
   * `synchronize: false` esto es documentación, no la fuente de la
   * restricción — la crea la migración.
   */
  @Column({ name: 'phone', type: 'varchar', length: 10, unique: true })
  phone: string;

  /**
   * PIN de 4 dígitos en texto plano, 1 a 1 con la cuenta. Deliberadamente sin
   * `unique`: ver README sección 5 (dos cuentas pueden compartir el mismo
   * PIN numérico sin que eso rompa nada).
   */
  @Column({ name: 'pin', type: 'varchar', length: 4 })
  pin: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToMany(() => Ticket, (ticket) => ticket.usuario)
  tickets: Ticket[];

  /** Catálogo de productos privado de esta cuenta (ver `producto.entity.ts`). */
  @OneToMany(() => Producto, (producto) => producto.usuario)
  productos: Producto[];

  @OneToMany(() => RefreshToken, (refreshToken) => refreshToken.usuario)
  refreshTokens: RefreshToken[];
}
