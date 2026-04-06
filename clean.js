const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clean() {
  const deleted = await prisma.mouvementStock.deleteMany({});
  console.log('Mouvements supprimes:', deleted.count);
  await prisma.$disconnect();
}

clean();