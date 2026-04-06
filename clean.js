const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fix() {
  const cq = await prisma.controleQualite.deleteMany({});
  console.log('Controles supprimes:', cq.count);
  const lbr = await prisma.ligneBonReception.deleteMany({});
  console.log('Lignes BR supprimees:', lbr.count);
  const br = await prisma.bonReception.deleteMany({});
  console.log('Bons supprimes:', br.count);
  await prisma.$disconnect();
}

fix();