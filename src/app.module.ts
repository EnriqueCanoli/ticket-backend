import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { PasswordResetToken } from './auth/entities/password-reset-token.entity';
import { Suscripcion } from './suscripciones/entities/suscripcion.entity';
import { Compra } from './suscripciones/entities/compra.entity';
import { PagoHistorial } from './suscripciones/entities/pago-historial.entity';
import { EventoTienda } from './suscripciones/entities/evento-tienda.entity';
import { SuscripcionesModule } from './suscripciones/suscripciones.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 60,
      },
    ]),
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
        entities: [
          Usuario,
          Producto,
          Ticket,
          TicketItem,
          RefreshToken,
          PasswordResetToken,
          Suscripcion,
          Compra,
          PagoHistorial,
          EventoTienda,
        ],
        synchronize: false,
        uuidExtension: 'pgcrypto',
        ssl:
          configService.get<string>('DB_SSL') === 'true'
            ? { rejectUnauthorized: false }
            : false,
      }),
    }),
    AuthModule,
    ProductosModule,
    TicketsModule,
    ReportesModule,
    SuscripcionesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
