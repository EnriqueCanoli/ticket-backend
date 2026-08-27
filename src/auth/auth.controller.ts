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
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { Usuario } from '../usuarios/entities/usuario.entity';
import type {
  AuthResponse,
  MeResponse,
  PinResponse,
  TokenPairResponse,
} from './interfaces/auth-response.interface';

/**
 * Rutas y códigos HTTP tal como AUTH_ENDPOINTS.md sección 3: `/auth/register`
 * responde 201 (crea la cuenta), `/auth/login` y `/auth/refresh` responden
 * 200, y `GET /me` (sin prefijo `/auth`) vive protegido por JwtAuthGuard.
 */
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Límite dedicado y más estricto que el resto de la API (hallazgo de
  // seguridad H8): a diferencia de /auth/login (que no revela si un email
  // existe), /auth/register sí lo hace por diseño — 409 confirma la cuenta,
  // 201 la descarta. El registro legítimo de una cuenta es además un evento
  // raro por IP (a diferencia del login, que un mismo usuario repite todo el
  // tiempo), así que puede tolerar un límite mucho más bajo sin afectar el
  // uso normal.
  //
  // Esto MITIGA el hueco de enumeración (hace impráctico enumerar una lista
  // completa de correos del negocio) pero no lo elimina: la única forma de
  // cerrarlo del todo es no revelar nada de inmediato y confirmar la cuenta
  // por correo electrónico, lo cual requiere infraestructura de email que
  // este proyecto no tiene hoy — decisión de producto, fuera de alcance.
  @Throttle({ default: { limit: 3, ttl: 1800000 } })
  @Post('auth/register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<AuthResponse> {
    return this.authService.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponse> {
    return this.authService.login(dto);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPairResponse> {
    return this.authService.refresh(dto);
  }

  // Revoca solo el refresh token de la sesión/dispositivo actual
  // (AUTH_ENDPOINTS.md sección 7). Requiere el access token vigente
  // (JwtAuthGuard) para resolver `usuario.id` y verificar que el
  // refresh_token del body le pertenece — nunca se confía en un
  // usuario_id del body.
  @Post('auth/logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  logout(
    @Body() dto: RefreshTokenDto,
    @CurrentUser() usuario: Usuario,
  ): Promise<void> {
    return this.authService.logout(dto, usuario.id);
  }

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() usuario: Usuario): MeResponse {
    return this.authService.toMeResponse(usuario);
  }

  @Get('me/pin')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  mePin(@CurrentUser() usuario: Usuario): PinResponse {
    return this.authService.toPinResponse(usuario);
  }
}
