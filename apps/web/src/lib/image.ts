/**
 * Reduz a foto no navegador antes de enviar: lado maior até `max` px, WebP (ou JPEG, se o
 * navegador não gerar WebP). Uma foto de celular de 4 MB vira algo como 80–150 KB.
 */
export async function shrinkImage(file: File, max = 1000, quality = 0.82): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem (JPG, PNG ou WebP).');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('Não foi possível abrir esta imagem. Tente uma foto JPG ou PNG.');
  });
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const webp = canvas.toDataURL('image/webp', quality);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
}
