import { AppError } from './store.js';
export function entityFields(body) {
  if (typeof body.name !== 'string' || !body.name.trim() || /[\r\n]/.test(body.name) || body.name.trim().length > 80) throw new AppError(400, 'Название должно содержать от 1 до 80 символов');
  if (!['color', 'emoji'].includes(body.iconType) || typeof body.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(body.color)) throw new AppError(400, 'Выберите цвет или эмодзи');
  const emoji = body.emoji || '';
  if (typeof emoji !== 'string' || emoji.length > 32 || (body.iconType === 'emoji' && ([...new Intl.Segmenter().segment(emoji)].length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji)))) throw new AppError(400, 'Введите один эмодзи');
  return { name: body.name.trim(), iconType: body.iconType, color: body.color.toLowerCase(), emoji: body.iconType === 'emoji' ? emoji : '' };
}
