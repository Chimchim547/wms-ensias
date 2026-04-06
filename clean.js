const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanAll() {
  const lp = await prisma.lignePicking.deleteMany({});
  console.log('LignesPicking supprimees:', lp.count);
  
  const lk = await prisma.listePicking.deleteMany({});
  console.log('ListesPicking supprimees:', lk.count);
  
  const lc = await prisma.ligneCommande.deleteMany({});
  console.log('LignesCommande supprimees:', lc.count);
  
  const cmd = await prisma.commande.deleteMany({});
  console.log('Commandes supprimees:', cmd.count);
  
  const li = await prisma.ligneInventaire.deleteMany({});
  console.log('LignesInventaire supprimees:', li.count);
  
  const inv = await prisma.inventaire.deleteMany({});
  console.log('Inventaires supprimes:', inv.count);
  
  const mv = await prisma.mouvementStock.deleteMany({});
  console.log('Mouvements supprimes:', mv.count);
  
  const cq = await prisma.controleQualite.deleteMany({});
  console.log('ControlesQualite supprimes:', cq.count);
  
  const lbr = await prisma.ligneBonReception.deleteMany({});
  console.log('LignesBonReception supprimees:', lbr.count);
  
  const br = await prisma.bonReception.deleteMany({});
  console.log('BonsReception supprimes:', br.count);
  
  const notif = await prisma.notification.deleteMany({});
  console.log('Notifications supprimees:', notif.count);
  
  console.log('\nTout est nettoye ! Articles, zones, emplacements, fournisseurs et utilisateurs sont conserves.');
  
  await prisma.$disconnect();
}

cleanAll();