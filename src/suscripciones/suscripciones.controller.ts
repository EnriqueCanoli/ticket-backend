import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import { CompraSuscripcionService } from './compra-suscripcion.service';
import { RestaurarComprasDto } from './dto/restaurar-compras.dto';
import { ValidarCompraDto } from './dto/validar-compra.dto';
import type { SuscripcionSnapshot } from './interfaces/suscripcion-response.interface';
import { SuscripcionesService } from './suscripciones.service';

/**
 * - GET /me/suscripcion: snapshot de la suscripción de la cuenta autenticada.
 *   Sin throttle propio (aplica el global) ni body. Si el snapshot falla sale
 *   el 500: el cliente lo trata como error de servidor y nunca bloquea.
 * - POST /me/suscripcion/validar-compra y /restaurar (etapa 4a): 200 con el
 *   snapshot; 400, 401, 409 TIENDA_EN_USO y 429. NUNCA llevan
 *   `SuscripcionActivaGuard`: una cuenta bloqueada tiene que poder pagar.
 */
@Controller()
export class SuscripcionesController {
  constructor(
    private readonly suscripcionesService: SuscripcionesService,
    private readonly compraSuscripcionService: CompraSuscripcionService,
  ) {}

  @Get('me/suscripcion')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  obtener(@CurrentUser() usuario: Usuario): Promise<SuscripcionSnapshot> {
    return this.suscripcionesService.snapshot(usuario);
  }

  @Post('me/suscripcion/validar-compra')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  validarCompra(
    @Body() dto: ValidarCompraDto,
    @CurrentUser() usuario: Usuario,
  ): Promise<SuscripcionSnapshot> {
    return this.compraSuscripcionService.validarCompra(usuario, dto);
  }

  @Post('me/suscripcion/restaurar')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  restaurarCompras(
    @Body() dto: RestaurarComprasDto,
    @CurrentUser() usuario: Usuario,
  ): Promise<SuscripcionSnapshot> {
    return this.compraSuscripcionService.restaurarCompras(usuario, dto);
  }
}
