import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JwtService } from '@nestjs/jwt';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { randomBytes, createHash, randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import {
  AuthResponse,
  MeResponse,
  PinResponse,
  TokenPairResponse,
  UserResponse,
} from './interfaces/auth-response.interface';

/** Rondas de salt para bcryptjs (password). */
const SALT_ROUNDS = 10;

/**
 * Hash bcrypt "señuelo" contra el que se compara cuando el email no existe, para
 * pagar siempre el mismo costo de bcrypt.compare (~10 rondas) sin importar si la
 * cuenta existe. Sin esto, un email inexistente respondía en milisegundos mientras
 * uno real pagaba el costo completo de bcrypt — un oráculo de temporización que
 * permitía enumerar cuentas registradas aunque el mensaje de error fuera idéntico
 * en ambos casos. Cualquier hash válido sirve: el password que mande el cliente
 * nunca podrá coincidir con la cadena fija usada para generarlo.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'dummy-password-para-igualar-tiempos',
  SALT_ROUNDS,
);

/** Mensaje genérico para no revelar si el email existe o si fue el password lo que falló. */
const INVALID_CREDENTIALS_MESSAGE = 'Credenciales inválidas';

/** Mensaje genérico para cualquier refresh token inválido/expirado/revocado/reusado. */
const INVALID_REFRESH_TOKEN_MESSAGE = 'Refresh token inválido';

/** SQLSTATE de Postgres para `unique_violation`. */
const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del índice único funcional sobre LOWER(email) creado por la
 * migración NormalizeUsuariosEmail1786870000000. Postgres lo reporta tanto
 * en el campo `constraint` del error como dentro del texto del mensaje.
 */
const EMAIL_UNIQUE_INDEX = 'UQ_usuarios_email_lower';

/**
 * Forma real del error del driver `pg` que TypeORM adjunta como
 * `QueryFailedError.driverError` (y además copia como propiedades propias
 * sobre la instancia). `QueryFailedError<T extends Error = Error>` sólo
 * declara `query`, `parameters` y `driverError`, así que `code` y
 * `constraint` hay que tipearlos acá para no usar `any`.
 */
type PostgresDriverError = Error & {
  code?: string;
  constraint?: string;
};

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
    this.accessTokenTtlSeconds = parseInt(
      this.configService.get<string>('ACCESS_TOKEN_TTL', '900'),
      10,
    );
    this.refreshTokenTtlSeconds = parseInt(
      this.configService.get<string>('REFRESH_TOKEN_TTL', '2592000'),
      10,
    );
  }

  async register(dto: RegisterDto): Promise<AuthResponse> {
    // Normalizado acá (no en el DTO): el ValidationPipe global no usa
    // `transform: true`, así que un @Transform() en el DTO no llegaría a
    // aplicarse sobre el objeto que recibe este método (mismo motivo por el
    // que ProductosService.search() hace `search.trim()` acá y no en su DTO).
    // Sin esto, "Juan@gmail.com" y "juan@gmail.com" se tratarían como cuentas
    // distintas.
    const email = dto.email.trim().toLowerCase();

    const existing = await this.usuarioRepository.findOne({
      where: { email },
    });
    if (existing) {
      throw new ConflictException('El email ya está registrado');
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const pin = this.generatePin();

    const usuario = this.usuarioRepository.create({
      email,
      passwordHash,
      phone: dto.phone,
      pin,
      aceptoTerminos: dto.aceptoTerminos,
    });
    try {
      await this.usuarioRepository.save(usuario);
    } catch (error) {
      // Carrera check-then-act: entre el findOne() de arriba y este save(),
      // otra request concurrente pudo insertar el mismo email. El findOne no
      // la veía (esa fila todavía no estaba guardada) y es Postgres quien
      // rechaza la inserción con el índice único UQ_usuarios_email_lower.
      // Sin este catch, el QueryFailedError sale sin manejar y Nest responde
      // 500 {"statusCode":500,"message":"Internal server error"} en vez del
      // 409 documentado — aunque la otra request sí haya creado la cuenta.
      if (error instanceof QueryFailedError) {
        const driverError = error.driverError as PostgresDriverError;
        if (driverError.code === POSTGRES_UNIQUE_VIOLATION) {
          // `constraint` es la señal estructurada (pg la llena con el campo
          // `n` del ErrorResponse de Postgres). El fallback sobre el texto
          // cubre el caso raro de que ese campo no venga: el mensaje crudo
          // siempre trae el nombre entre comillas ('duplicate key value
          // violates unique constraint "UQ_usuarios_email_lower"').
          if (
            driverError.constraint === EMAIL_UNIQUE_INDEX ||
            error.message.includes(EMAIL_UNIQUE_INDEX)
          ) {
            throw new ConflictException('El email ya está registrado');
          }
          // Restricción única desconocida (ej. UQ_usuarios_phone, u otra
          // futura): mejor un 409 genérico que un 500 sin clasificar.
          throw new ConflictException('El registro ya existe');
        }
      }
      throw error;
    }

    const { refreshTokenEntity: _refreshTokenEntity, ...tokens } =
      await this.issueTokenPair(usuario);

    return {
      user: this.toUserResponse(usuario),
      ...tokens,
    };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    // Mismo motivo que register(): normalizado acá porque el DTO no pasa por
    // transform (ver comentario de register()).
    const email = dto.email.trim().toLowerCase();

    const usuario = await this.usuarioRepository.findOne({
      where: { email },
    });

    // Mismo error genérico Y mismo costo de bcrypt tanto si el email no existe
    // como si el password no coincide, para no filtrar por temporización qué
    // correos están registrados (AUTH_ENDPOINTS.md sección 3, ambigüedad punto 3).
    const passwordMatches = await bcrypt.compare(
      dto.password,
      usuario?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!usuario || !passwordMatches) {
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
    const { refreshTokenEntity, ...tokens } =
      await this.issueTokenPair(usuario);

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

  toPinResponse(usuario: Usuario): PinResponse {
    return { pin: usuario.pin };
  }

  private toUserResponse(usuario: Usuario): UserResponse {
    // Mapper explícito: nunca se confía en la serialización automática de la
    // entidad completa, para no exponer `passwordHash`/`pin` (sección 3 y
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
