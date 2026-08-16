import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Protege rutas que requieren `Authorization: Bearer <access_token>` (ej. GET /me). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
