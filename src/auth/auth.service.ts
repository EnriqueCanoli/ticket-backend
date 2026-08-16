import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { IsNull, Repository } from 'typeorm';
import { randomBytes, createHash, randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { AuthResponse, MeResponse, TokenPairResponse, UserResponse } from './interfaces/auth-response.interface';

/** Rondas de salt para bcryptjs (password y pin). */
const SALT_ROUNDS = 10;

/** Mensaje genérico para no revelar si el email existe o si fue el password lo que falló. */
const INVALID_CREDENTIALS_MESSAGE = 'Credenciales inválidas';

/** Mensaje genérico para cualquier refresh token inválido/expirado/revocado/reusado. */
const INVALID_REFRESH_TOKEN_MESSAGE = 'Refresh token inválido';

@Injectable()
export class AuthService {
  /** Vida útil del access token, en segundos. Default 900 (15 min) — AUTH_ENDPOINTS.md sección 2. */
  private readonly accessTokenTtlSeconds: number;

  /** Vida útil del refresh token, en segundos. Default 2 592 000 (30 días). */
  private readonly refreshTokenTtlSeconds: number;

  constructor(
    @InjectRepository(Usuario)
    private readonly usuarioRepository: Repository<Usuario>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.accessTokenTtlSeconds = parseInt(this.configService.get<string>('ACCESS_TOKEN_TTL', '900'), 10);
    this.refreshTokenTtlSeconds = parseInt(this.configService.get<string>('REFRESH_TOKEN_TTL', '2592000'), 10);
  }

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const existing = await this.usuarioRepository.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('El email ya está registrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const pin = this.generatePin();
    const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);

    const usuario = this.usuarioRepository.create({
      email: dto.email,
      passwordHash,
      phone: dto.phone,
      pinHash,
    });
    await this.usuarioRepository.save(usuario);

    const { refreshTokenEntity: _refreshTokenEntity, ...tokens } = await this.issueTokenPair(usuario);

    return {
      user: this.toUserResponse(usuario),
      ...tokens,
    };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const usuario = await this.usuarioRepository.findOne({ where: { email: dto.email } });

    // Mismo error genérico tanto si el email no existe como si el password no
    // coincide, para no filtrar por enumeración qué correos están registrados
    // (AUTH_ENDPOINTS.md sección 3, ambigüedad punto 3).
    if (!usuario) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const passwordMatches = await bcrypt.compare(dto.password, usuario.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const tokens = await this.issueTokenPair(usuario);

    return {
      user: this.toUserResponse(usuario),
      ...tokens,
    };
  }

  async refresh(dto: RefreshTokenDto): Promise<TokenPairResponse> {
    const tokenHash = this.hashOpaqueToken(dto.refresh_token);
    const existingToken = await this.refreshTokenRepository.findOne({
      where: { tokenHash },
      relations: { usuario: true },
    });

    if (!existingToken) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    if (existingToken.revokedAt) {
      // Reuso de un token ya rotado: señal de robo. Se revoca en cascada toda
      // la cadena de refresh tokens vigentes de ese usuario (AUTH_ENDPOINTS.md
      // sección 3, nota de seguridad de /auth/refresh).
      if (existingToken.replacedById) {
        await this.revokeAllActiveTokensForUser(existingToken.usuarioId);
      }
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    if (existingToken.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException(INVALID_REFRESH_TOKEN_MESSAGE);
    }

    const usuario = existingToken.usuario;
    const { refreshTokenEntity, ...tokens } = await this.issueTokenPair(usuario);

    existingToken.revokedAt = new Date();
    existingToken.replacedById = refreshTokenEntity.id;
    await this.refreshTokenRepository.save(existingToken);

    return tokens;
  }

  /** Usado por JwtStrategy para validar el usuario del payload (`sub`) y adjuntarlo a `request.user`. */
  async validateUserById(id: string): Promise<Usuario> {
    const usuario = await this.usuarioRepository.findOne({ where: { id } });
    if (!usuario) {
      throw new UnauthorizedException();
    }
    return usuario;
  }

  toMeResponse(usuario: Usuario): MeResponse {
    return {
      ...this.toUserResponse(usuario),
      updated_at: usuario.updatedAt,
    };
  }

  private toUserResponse(usuario: Usuario): UserResponse {
    // Mapper explícito: nunca se confía en la serialización automática de la
    // entidad completa, para no exponer `passwordHash`/`pinHash` (sección 3 y
    // 5.7 del doc).
    return {
      id: usuario.id,
      email: usuario.email,
      phone: usuario.phone,
      created_at: usuario.createdAt,
    };
  }

  private generatePin(): string {
    // PIN de 4 dígitos (0000-9999), generado automáticamente al registrar la
    // cuenta (README_DB_PROPUESTA.md sección 3.1).
    return randomInt(0, 10000).toString().padStart(4, '0');
  }

  private hashOpaqueToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async issueTokenPair(
    usuario: Usuario,
  ): Promise<TokenPairResponse & { refreshTokenEntity: RefreshToken }> {
    const payload: JwtPayload = { sub: usuario.id, email: usuario.email };
    const accessToken = await this.jwtService.signAsync(payload, {
      expiresIn: this.accessTokenTtlSeconds,
    });

    const refreshTokenPlain = randomBytes(64).toString('hex');
    const refreshTokenEntity = this.refreshTokenRepository.create({
      usuarioId: usuario.id,
      tokenHash: this.hashOpaqueToken(refreshTokenPlain),
      expiresAt: new Date(Date.now() + this.refreshTokenTtlSeconds * 1000),
    });
    await this.refreshTokenRepository.save(refreshTokenEntity);

    return {
      access_token: accessToken,
      refresh_token: refreshTokenPlain,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSeconds,
      refreshTokenEntity,
    };
  }

  private async revokeAllActiveTokensForUser(usuarioId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { usuarioId, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }
}
