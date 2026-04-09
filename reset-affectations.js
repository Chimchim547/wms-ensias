const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function reset() {
  const se = await prisma.stockEmplacement.deleteMany();
  console.log('StockEmplacement vide:', se.count);
  const art = await prisma.article.updateMany({ data: { emplacementId: null } });
  console.log('Articles desaffectes:', art.count);
  await prisma.$disconnect();
}

reset();