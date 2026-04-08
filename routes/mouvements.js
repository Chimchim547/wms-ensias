const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const { type, recherche } = req.query;
  
  const where = {};
  
  // Filtrer par type si demandé
  if (type) {
    where.type = type;
  }
  
  // Filtrer par rôle : chaque acteur voit les mouvements qui le concernent
  if (req.user.role === 'RESPONSABLE_RECEPTION') {
    where.type = 'ENTREE';
  } else if (req.user.role === 'RESPONSABLE_COMMANDE') {
    where.type = 'SORTIE';
  }
  // MAGASINIER et RESPONSABLE_ENTREPOT et ADMINISTRATEUR voient tout
  
  const mouvements = await prisma.mouvementStock.findMany({
    where,
    include: { article: true },
    orderBy: { date: 'desc' }
  });
  
  res.render('mouvements/index', { mouvements, filtres: { type: type || '' } });
});

router.get('/transfert', async (req, res) => {
  const articles = await prisma.article.findMany({
    where: { emplacementId: { not: null } },
    include: { emplacement: { include: { zone: true } } }
  });
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: true, articles: true }
  });
  const emplacementsLibres = emplacements.filter(e => e.articles.length === 0);
  
  // Pour chaque article, trouver les emplacements compatibles
  const articlesWithCompatible = articles.map(article => {
    const compatibles = emplacementsLibres.filter(e => 
      article.longueur <= e.longueur &&
      article.largeur <= e.largeur &&
      article.hauteur <= e.hauteur &&
      article.poids <= e.poidsMax &&
      article.longueur <= e.zone.dimensionMaxLongueur &&
      article.largeur <= e.zone.dimensionMaxLargeur &&
      article.hauteur <= e.zone.dimensionMaxHauteur &&
      article.poids <= e.zone.poidsMax
    );
    return { ...article, compatibles };
  });
  
  res.render('mouvements/transfert', { articles: articlesWithCompatible, emplacements: emplacementsLibres });
});

router.post('/transfert', async (req, res) => {
  const { articleId, newEmplacementId } = req.body;
  
  const article = await prisma.article.findUnique({
    where: { id: parseInt(articleId) },
    include: { emplacement: true }
  });
  
  const ancienEmplacement = article.emplacement ? article.emplacement.code : 'N/A';
  
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(newEmplacementId) }
  });
  
  const nouvelEmplacement = await prisma.emplacement.findUnique({
    where: { id: parseInt(newEmplacementId) }
  });
  
  await prisma.mouvementStock.create({
    data: {
      type: 'TRANSFERT',
      quantite: 1,
      articleId: parseInt(articleId)
    }
  });

  // Notif pour le responsable entrepôt
  await prisma.notification.create({
    data: {
      message: 'Article ' + article.reference + ' déplacé de ' + ancienEmplacement + ' vers ' + nouvelEmplacement.code,
      lien: '/mouvements',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect('/mouvements');
});

router.get('/pdf', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const { type } = req.query;
  
  const where = {};
  if (type) where.type = type;
  
  if (req.user.role === 'RESPONSABLE_RECEPTION') where.type = 'ENTREE';
  else if (req.user.role === 'RESPONSABLE_COMMANDE') where.type = 'SORTIE';
  
  const mouvements = await prisma.mouvementStock.findMany({
    where,
    include: { article: true },
    orderBy: { date: 'desc' }
  });

  const doc = new PDFDocument({ margin: 50 });
  const titre = type ? 'Mouvements - ' + type + 'S' : 'Tous les Mouvements de Stock';
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=MOUVEMENTS-' + new Date().toISOString().slice(0,10) + '.pdf');
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text(titre, { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();

  // Résumé
  const entrees = mouvements.filter(m => m.type === 'ENTREE');
  const sorties = mouvements.filter(m => m.type === 'SORTIE');
  const transferts = mouvements.filter(m => m.type === 'TRANSFERT');
  
  doc.fontSize(10).font('Helvetica');
  doc.text('Date du rapport: ' + new Date().toLocaleDateString('fr-FR'));
  doc.text('Total mouvements: ' + mouvements.length + '  |  Entrees: ' + entrees.length + '  |  Sorties: ' + sorties.length + '  |  Transferts: ' + transferts.length);
  doc.moveDown();

  // Tableau
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Date', 50, tableTop, { width: 70 });
  doc.text('Heure', 120, tableTop, { width: 50 });
  doc.text('Type', 170, tableTop, { width: 80 });
  doc.text('Reference', 250, tableTop, { width: 70 });
  doc.text('Designation', 320, tableTop, { width: 150 });
  doc.text('Qte', 470, tableTop, { width: 50 });
  
  doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(9);
  let y = tableTop + 25;
  
  mouvements.forEach(m => {
    if (y > 700) {
      doc.addPage();
      y = 50;
    }
    
    doc.text(m.date.toLocaleDateString('fr-FR'), 50, y, { width: 70 });
    doc.text(m.date.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'}), 120, y, { width: 50 });
    doc.text(m.type, 170, y, { width: 80 });
    doc.text(m.article.reference, 250, y, { width: 70 });
    doc.text(m.article.designation, 320, y, { width: 150 });
    doc.text(String(m.quantite), 470, y, { width: 50 });
    y += 18;
  });

  // Pied de page
  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
  doc.moveDown();
  doc.font('Helvetica').fontSize(10);
  doc.text('Resp. Entrepot: ________________     Signature: ________________');
  doc.moveDown(2);
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});
module.exports = router;