import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { Producto } from '../productos/entities/producto.entity';
import { Ticket } from '../tickets/entities/ticket.entity';
import { TicketItem } from '../tickets/entities/ticket-item.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';

/**
 * DataSource standalone usado por el CLI de migraciones de TypeORM
 * (`typeorm-ts-node-commonjs -d src/database/data-source.ts migration:run`, etc.).
 *
 * No confundir con `TypeOrmModule.forRootAsync(...)`, que se configurará
 * aparte para el bootstrap de Nest cuando exista `AppModule`. Aquí no hay
 * contenedor de Nest disponible, por eso se leen las variables de entorno
 * directamente de `process.env` (cargadas vía `dotenv/config`) en vez de
 * `ConfigService`.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [Usuario, Producto, Ticket, TicketItem, RefreshToken],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
  // La migración inicial activa pgcrypto y usa gen_random_uuid() (README
  // sección 1). Se fija explícitamente aquí para que la metadata de las
  // entidades (@PrimaryGeneratedColumn('uuid')) sea consistente con eso:
  // sin esto, el driver de Postgres de TypeORM asume uuid-ossp/
  // uuid_generate_v4() por defecto.
  uuidExtension: 'pgcrypto',
};

const dataSource = new DataSource(dataSourceOptions);

export default dataSource;
