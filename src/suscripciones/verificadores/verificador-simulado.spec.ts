import type { VerificadorTienda } from './verificador-tienda.interface';
import { aIsoNegocio } from '../fechas';
import {
  CUENTA_SIMULADA_AJENA,
  MONEDA_SIMULADA,
  MONTO_SIMULADO,
  VerificadorSimulado,
} from './verificador-simulado';

const AHORA = new Date('2026-03-14T14:05:00-06:00');
const entrada = (tokenCompra: string) => ({
  productoId: 'PENDIENTE',
  tokenCompra,
});
const verificador = () => new VerificadorSimulado(() => AHORA);

describe('VerificadorSimulado', () => {
  it('mock-compra-: activa, ahora a +1 mes, 99 MXN, con renovación', async () => {
    const r = await verificador().verificar(entrada('mock-compra-abc-1'));
    expect(r.estado).toBe('activa');
    expect(r.periodoInicio).toEqual(AHORA);
    expect(aIsoNegocio(r.periodoFin as Date)).toBe('2026-04-14T14:05:00-06:00');
    expect(r.autoRenovacion).toBe(true);
    expect(r.cuentaOfuscada).toBeNull();
    expect(r.monto).toBe(MONTO_SIMULADO);
    expect(r.moneda).toBe(MONEDA_SIMULADA);
    expect(r.orderId).toMatch(/^SIM-[0-9a-f]{24}$/);
  });

  it('mock-compra-a-medias- se comporta como mock-compra-', async () => {
    const r = await verificador().verificar(entrada('mock-compra-a-medias-x'));
    expect(r.estado).toBe('activa');
    expect(aIsoNegocio(r.periodoFin as Date)).toBe('2026-04-14T14:05:00-06:00');
  });

  it('mock-pendiente-: pendiente sin fechas, monto ni cuenta', async () => {
    const r = await verificador().verificar(entrada('mock-pendiente-abc-1'));
    expect(r).toMatchObject({
      estado: 'pendiente',
      periodoInicio: null,
      periodoFin: null,
      autoRenovacion: false,
      cuentaOfuscada: null,
      monto: null,
      moneda: null,
    });
    expect(r.orderId).toMatch(/^SIM-[0-9a-f]{24}$/);
  });

  it('mock-tienda-en-uso-: como mock-compra- pero con cuenta ajena', async () => {
    const r = await verificador().verificar(entrada('mock-tienda-en-uso-x'));
    expect(r.estado).toBe('activa');
    expect(r.cuentaOfuscada).toBe(CUENTA_SIMULADA_AJENA);
  });

  it('el orderId es determinista y distinto por token', async () => {
    const a1 = await verificador().verificar(entrada('mock-compra-a'));
    const a2 = await new VerificadorSimulado().verificar(
      entrada('mock-compra-a'),
    );
    const b = await verificador().verificar(entrada('mock-compra-b'));
    expect(a1.orderId).toBe(a2.orderId);
    expect(a1.orderId).not.toBe(b.orderId);
  });

  it('un token desconocido se rechaza', async () => {
    const r = await verificador().verificar(entrada('basura'));
    expect(r.estado).toBe('rechazada');
    expect(r.orderId).toBeNull();
  });

  it('reconocer no hace nada', async () => {
    await expect(
      (verificador() as VerificadorTienda).reconocer(entrada('mock-compra-a')),
    ).resolves.toBeUndefined();
  });
});
