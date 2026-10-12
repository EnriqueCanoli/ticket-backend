import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import type { SuscripcionSnapshot } from './interfaces/suscripcion-response.interface';
import { SuscripcionesService } from './suscripciones.service';

/**
 * GET /me/suscripcion: snapshot de la suscripción de la cuenta autenticada.
 * Sin throttle propio (aplica el global) ni body. Si el snapshot falla sale
 * el 500: el cliente lo trata como error de servidor y nunca bloquea.
 */
@Controller()
export class SuscripcionesController {
  constructor(private readonly suscripcionesService: SuscripcionesService) {}

  @Get('me/suscripcion')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  obtener(@CurrentUser() usuario: Usuario): Promise<SuscripcionSnapshot> {
    return this.suscripcionesService.snapshot(usuario);
  }
}
