import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Se dejó de hashear el PIN (decisión de producto): ahora se guarda en texto
 * plano para poder devolverlo tal cual vía `GET /me/pin`. Con eso, el nombre
 * `pin_hash` dejó de tener sentido — se renombra a `pin` y se reduce el tipo
 * a `varchar(4)` (el PIN son 4 caracteres).
 *
 * A diferencia de `AddUsuarioIdToProductos1786840000000` (que solo agregaba
 * una columna nueva), acá SÍ hace falta backfill: las filas existentes
 * todavía tienen el hash de bcrypt viejo (~60 caracteres) en esa columna, que
 * no cabe en `varchar(4)` y de todos modos dejó de ser un PIN utilizable (el
 * valor original en claro nunca se puede recuperar de un hash). Se regenera
 * un PIN de 4 dígitos nuevo para cada usuario existente antes de achicar el
 * tipo, con el mismo formato que `AuthService.generatePin()` (0000-9999,
 * ceros a la izquierda).
 */
export class RenamePinHashToPinInUsuarios1786860000000 implements MigrationInterface {
  name = 'RenamePinHashToPinInUsuarios1786860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" RENAME COLUMN "pin_hash" TO "pin";
    `);
    await queryRunner.query(`
      UPDATE "usuarios" SET "pin" = LPAD(FLOOR(RANDOM() * 10000)::text, 4, '0');
    `);
    await queryRunner.query(`
      ALTER TABLE "usuarios" ALTER COLUMN "pin" TYPE varchar(4);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" ALTER COLUMN "pin" TYPE varchar(255);
    `);
    await queryRunner.query(`
      ALTER TABLE "usuarios" RENAME COLUMN "pin" TO "pin_hash";
    `);
  }
}
