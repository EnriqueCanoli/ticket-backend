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

  @Column({ name: 'email', type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ name: 'phone', type: 'varchar', length: 10 })
  phone: string;

  /**
   * PIN de 4 dígitos hasheado, 1 a 1 con la cuenta. Deliberadamente sin
   * `unique`: ver README sección 5 (dos cuentas pueden compartir el mismo
   * PIN numérico en claro sin que eso rompa nada, el hash con salt nunca
   * coincidiría igual entre cuentas distintas).
   */
  @Column({ name: 'pin_hash', type: 'varchar', length: 255 })
  pinHash: string;

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
