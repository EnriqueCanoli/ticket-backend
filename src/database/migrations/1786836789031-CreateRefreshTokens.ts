import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agrega la tabla `refresh_tokens`, requerida por la estrategia de sesión de
 * AUTH_ENDPOINTS.md sección 2 (access JWT de vida corta + refresh token
 * opaco persistido, rotado en cada uso de POST /auth/refresh). Ver sección 4
 * de ese documento para el diccionario de columnas.
 */
export class CreateRefreshTokens1786836789031 implements MigrationInterface {
  name = 'CreateRefreshTokens1786836789031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "usuario_id" uuid NOT NULL,
        "token_hash" varchar(255) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz NULL,
        "replaced_by_id" uuid NULL,
        CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_refresh_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_refresh_tokens_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_refresh_tokens_replaced_by_id" FOREIGN KEY ("replaced_by_id")
          REFERENCES "refresh_tokens" ("id") ON DELETE SET NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_refresh_tokens_usuario_id" ON "refresh_tokens" ("usuario_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "refresh_tokens";`);
  }
}
