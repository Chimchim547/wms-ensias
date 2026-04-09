const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clean() {
  const n = await prisma.notification.deleteMany({});
  console.log('Notifications supprimées:', n.count);

  const lp = await prisma.lignePicking.deleteMany({});
  console.log('Lignes picking supprimées:', lp.count);

  const lsp = await prisma.listePicking.deleteMany({});
  console.log('Listes picking supprimées:', lsp.count);

  const lc = await prisma.ligneCommande.deleteMany({});
  console.log('Lignes commande supprimées:', lc.count);

  const cmd = await prisma.commande.deleteMany({});
  console.log('Commandes supprimées:', cmd.count);

  const cq = await prisma.controleQualite.deleteMany({});
  console.log('Contrôles qualité supprimés:', cq.count);

  const lbr = await prisma.ligneBonReception.deleteMany({});
  console.log('Lignes réception supprimées:', lbr.count);

  const br = await prisma.bonReception.deleteMany({});
  console.log('Bons réception supprimés:', br.count);

  const li = await prisma.ligneInventaire.deleteMany({});
  console.log('Lignes inventaire supprimées:', li.count);

  const inv = await prisma.inventaire.deleteMany({});
  console.log('Inventaires supprimés:', inv.count);

  const mv = await prisma.mouvementStock.deleteMany({});
  console.log('Mouvements stock supprimés:', mv.count);

  const art = await prisma.article.updateMany({
    data: { emplacementId: null, coutMoyenPondere: 0 }
  });
  console.log('Articles remis à zéro:', art.count);

  console.log('--- NETTOYAGE TERMINE ---');
  await prisma.$disconnect();
}

clean().catch(e => { console.error(e); process.exit(1); });