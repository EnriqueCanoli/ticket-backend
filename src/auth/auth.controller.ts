import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
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

  @Post('auth/register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto): Promise<AuthResponse> {
    return this.authService.register(dto);
  }

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

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() usuario: Usuario): MeResponse {
    return this.authService.toMeResponse(usuario);
  }
}
