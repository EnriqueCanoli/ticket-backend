import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Usuario } from '../../usuarios/entities/usuario.entity';
import { SuscripcionesService } from '../suscripciones.service';

/**
 * Bloquea las escrituras de una cuenta con la suscripción no activa. Debe ir
 * SIEMPRE después de `JwtAuthGuard` (lee `request.user`). Nunca devuelve
 * `false`: lanza la `ForbiddenException` con el código `SUSCRIPCION_REQUERIDA`
 * (si devolviera `false`, Nest respondería "Forbidden resource" y el cliente
 * no reconocería el código).
 */
@Injectable()
export class SuscripcionActivaGuard implements CanActivate {
  constructor(private readonly suscripcionesService: SuscripcionesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: Usuario }>();
    const usuario = request.user;
    if (!usuario) {
      throw new UnauthorizedException();
    }
    await this.suscripcionesService.assertPuedeEscribir(usuario);
    return true;
  }
}
