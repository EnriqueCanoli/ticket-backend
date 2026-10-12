import { HMAC_SECRETO_DESARROLLO } from './config-suscripcion';
import type { ConfigSuscripcion } from './config-suscripcion';
import {
  calcularCuentaOfuscada,
  CuentaOfuscadaService,
} from './cuenta-ofuscada';

describe('calcularCuentaOfuscada', () => {
  it('coincide con un vector fijo (HMAC-SHA256 hex)', () => {
    expect(calcularCuentaOfuscada('usuario-1', 'secreto-de-prueba')).toBe(
      'a633b69a32e543fab25617bb326dccbfd91ce148b650dfdb2afe59f1ba11fea1',
    );
  });

  it('mide 64 caracteres hexadecimales', () => {
    const valor = calcularCuentaOfuscada('otro', 'secreto-de-prueba');
    expect(valor).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cambia con el usuario y con el secreto', () => {
    const base = calcularCuentaOfuscada('a', 's1');
    expect(calcularCuentaOfuscada('b', 's1')).not.toBe(base);
    expect(calcularCuentaOfuscada('a', 's2')).not.toBe(base);
  });
});

describe('CuentaOfuscadaService', () => {
  it('usa el secreto de la configuración', () => {
    const servicio = new CuentaOfuscadaService({
      hmacSecreto: HMAC_SECRETO_DESARROLLO,
    } as ConfigSuscripcion);
    expect(servicio.calcular('u')).toBe(
      calcularCuentaOfuscada('u', HMAC_SECRETO_DESARROLLO),
    );
  });
});
