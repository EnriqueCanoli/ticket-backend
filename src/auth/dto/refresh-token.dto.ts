import { IsNotEmpty, IsString } from 'class-validator';

/** AUTH_ENDPOINTS.md sección 3 (POST /auth/refresh). */
export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}
