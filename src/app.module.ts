import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ProductosModule } from './productos/productos.module';
import { TicketsModule } from './tickets/tickets.module';
import { ReportesModule } from './reportes/reportes.module';
import { Usuario } from './usuarios/entities/usuario.entity';
import { Producto } from './productos/entities/producto.entity';
import { Ticket } from './tickets/entities/ticket.entity';
import { TicketItem } from './tickets/entities/ticket-item.entity';
import { RefreshToken } from './auth/entities/refresh-token.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // Reusa las mismas variables de entorno que `src/database/data-source.ts`
      // (usado aparte por el CLI de migraciones) en vez de duplicar
      // credenciales hardcodeadas.
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<string>('DB_PORT')
          ? parseInt(configService.get<string>('DB_PORT')!, 10)
          : 5432,
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_NAME'),
        entities: [Usuario, Producto, Ticket, TicketItem, RefreshToken],
        synchronize: false,
        uuidExtension: 'pgcrypto',
      }),
    }),
    AuthModule,
    ProductosModule,
    TicketsModule,
    ReportesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
