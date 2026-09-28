import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthService } from '../auth.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { Usuario } from '../../usuarios/entities/usuario.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Sin default hardcodeado: si falta JWT_SECRET, el arranque falla
      // explícitamente (getOrThrow lanza en vez de dejar el guard corriendo
      // con un secreto vacío/adivinable).
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<Usuario> {
    // 401 si el usuario del payload ya no existe, o si el claim `tv` no
    // coincide con usuarios.token_version (token emitido antes de un reset
    // de contraseña). La lógica vive en AuthService.validateAccessTokenPayload().
    try {
      return await this.authService.validateAccessTokenPayload(payload);
    } catch {
      throw new UnauthorizedException();
    }
  }
}
