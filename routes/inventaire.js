const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const inventaires = await prisma.inventaire.findMany({
    include: { lignes: { include: { article: true } } }
  });
  res.render('inventaire/index', { inventaires });
});

router.get('/planifier', (req, res) => res.render('inventaire/planifier'));

router.post('/planifier', async (req, res) => {
  const { datePlanification } = req.body;
  
  const articles = await prisma.article.findMany({
    include: { mouvements: true }
  });
  
  const lignes = articles.map(article => {
    const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    const stockTheorique = entrees - sorties;
    return {
      articleId: article.id,
      reference: article.reference,
      designation: article.designation,
      quantiteTheorique: stockTheorique
    };
  });
  
  const inventaire = await prisma.inventaire.create({
    data: {
      datePlanification: new Date(datePlanification),
      lignes: { create: lignes }
    }
  });

  await prisma.notification.create({
    data: {
      message: `Inventaire #${inventaire.id} planifié pour le ${new Date(datePlanification).toLocaleDateString('fr-FR')} avec ${lignes.length} articles. Comptage physique à effectuer.`,
      lien: '/inventaire/comptage/' + inventaire.id,
      destinataireRole: 'MAGASINIER'
    }
  });

  res.redirect('/inventaire');
});

router.get('/comptage/:id', async (req, res) => {
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });
  res.render('inventaire/comptage', { inventaire });
});

router.post('/comptage/:id', async (req, res) => {
  const { ligneIds, quantitesReelles, justificatifs } = req.body;
  
  const ids = Array.isArray(ligneIds) ? ligneIds : [ligneIds];
  const qrs = Array.isArray(quantitesReelles) ? quantitesReelles : [quantitesReelles];
  const justs = Array.isArray(justificatifs) ? justificatifs : [justificatifs];
  
  let ecartsTrouves = false;

  for (let i = 0; i < ids.length; i++) {
    const ligne = await prisma.ligneInventaire.findUnique({ where: { id: parseInt(ids[i]) } });
    const qr = parseInt(qrs[i]);
    const ecart = qr - ligne.quantiteTheorique;
    
    if (ecart !== 0) ecartsTrouves = true;

    await prisma.ligneInventaire.update({
      where: { id: parseInt(ids[i]) },
      data: {
        quantiteReelle: qr,
        ecart: ecart,
        justificatif: justs[i] || null
      }
    });
  }

  if (ecartsTrouves) {
    await prisma.notification.create({
      data: {
        message: `⚠ Inventaire #${req.params.id} : des écarts ont été constatés lors du comptage physique. Rapprochement et validation nécessaires.`,
        lien: '/inventaire/detail/' + req.params.id,
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else {
    await prisma.notification.create({
      data: {
        message: `Inventaire #${req.params.id} : comptage physique terminé. Aucun écart constaté ✓. Validation en attente.`,
        lien: '/inventaire/detail/' + req.params.id,
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  }

  res.redirect('/inventaire');
});

router.post('/rapprochement/:id', async (req, res) => {
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: true }
  });
  
  for (const ligne of inventaire.lignes) {
    const ecart = ligne.quantiteReelle - ligne.quantiteTheorique;
    await prisma.ligneInventaire.update({
      where: { id: ligne.id },
      data: { ecart }
    });
  }

  await prisma.notification.create({
    data: {
      message: `Inventaire #${req.params.id} : rapprochement automatique effectué. Prêt pour validation.`,
      lien: '/inventaire/detail/' + req.params.id,
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect(`/inventaire/detail/${req.params.id}`);
});

router.post('/valider/:id', async (req, res) => {
  await prisma.inventaire.update({
    where: { id: parseInt(req.params.id) },
    data: { dateRealisation: new Date() }
  });

  await prisma.notification.create({
    data: {
      message: `Inventaire #${req.params.id} validé ✓. Les données de stock sont maintenant à jour.`,
      lien: '/inventaire/detail/' + req.params.id,
      destinataireRole: 'ADMINISTRATEUR'
    }
  });

  res.redirect('/inventaire');
});

router.get('/detail/:id', async (req, res) => {
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });
  let valeurInventaire = 0;
  inventaire.lignes.forEach(l => {
    valeurInventaire += l.quantiteReelle * l.article.coutMoyenPondere;
  });
  res.render('inventaire/detail', { inventaire, valeurInventaire });
});

router.get('/pdf/:id', async (req, res) => {
  const PDFDocument = require('pdfkit');
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });

  if (!inventaire) return res.status(404).send('Inventaire introuvable');

  const doc = new PDFDocument({ margin: 50, layout: 'landscape' });
  
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=INVENTAIRE-' + inventaire.id + '.pdf');
  doc.pipe(res);

  // En-tête
  doc.fontSize(20).font('Helvetica-Bold').text('WMS ENSIAS', { align: 'center' });
  doc.fontSize(14).text('Fiche d\'Inventaire #' + inventaire.id, { align: 'center' });
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(750, doc.y).stroke();
  doc.moveDown();

  // Infos
  doc.fontSize(10).font('Helvetica');
  doc.text('Date planification: ' + inventaire.datePlanification.toLocaleDateString('fr-FR'));
  doc.text('Date realisation: ' + (inventaire.dateRealisation ? inventaire.dateRealisation.toLocaleDateString('fr-FR') : 'Non valide'));
  doc.text('Statut: ' + (inventaire.dateRealisation ? 'Valide' : 'En cours'));
  doc.text('Nombre d\'articles: ' + inventaire.lignes.length);
  doc.moveDown();

  // Tableau
  doc.moveTo(50, doc.y).lineTo(750, doc.y).stroke();
  const tableTop = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Reference', 50, tableTop, { width: 70 });
  doc.text('Designation', 120, tableTop, { width: 150 });
  doc.text('Qte Theorique', 270, tableTop, { width: 80 });
  doc.text('Qte Reelle', 350, tableTop, { width: 70 });
  doc.text('Ecart', 420, tableTop, { width: 50 });
  doc.text('CUMP', 470, tableTop, { width: 70 });
  doc.text('Valeur', 540, tableTop, { width: 70 });
  doc.text('Justificatif', 610, tableTop, { width: 140 });
  
  doc.moveTo(50, tableTop + 15).lineTo(750, tableTop + 15).stroke();
  
  doc.font('Helvetica').fontSize(9);
  let y = tableTop + 25;
  let valeurTotale = 0;
  let totalEcarts = 0;
  
  inventaire.lignes.forEach(ligne => {
    const valeur = ligne.quantiteReelle * ligne.article.coutMoyenPondere;
    valeurTotale += valeur;
    if (ligne.ecart !== 0) totalEcarts++;
    
    doc.text(ligne.reference, 50, y, { width: 70 });
    doc.text(ligne.designation, 120, y, { width: 150 });
    doc.text(String(ligne.quantiteTheorique), 270, y, { width: 80 });
    doc.text(String(ligne.quantiteReelle), 350, y, { width: 70 });
    
    // Ecart en rouge si négatif, vert si positif
    const ecartStr = ligne.ecart > 0 ? '+' + ligne.ecart : String(ligne.ecart);
    doc.text(ecartStr, 420, y, { width: 50 });
    
    doc.text(ligne.article.coutMoyenPondere.toFixed(2) + ' DH', 470, y, { width: 70 });
    doc.text(valeur.toFixed(2) + ' DH', 540, y, { width: 70 });
    doc.text(ligne.justificatif || '-', 610, y, { width: 140 });
    y += 20;

    if (y > 500) {
      doc.addPage({ layout: 'landscape' });
      y = 50;
    }
  });

  // Résumé
  doc.moveDown(2);
  y = doc.y + 10;
  doc.moveTo(50, y).lineTo(750, y).stroke();
  y += 15;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Resume:', 50, y);
  y += 20;
  doc.font('Helvetica').fontSize(10);
  doc.text('Total articles: ' + inventaire.lignes.length, 50, y);
  doc.text('Articles avec ecart: ' + totalEcarts, 250, y);
  doc.text('Valeur totale inventaire: ' + valeurTotale.toFixed(2) + ' DH', 450, y);

  // Signatures
  y += 50;
  doc.text('Magasinier: ________________', 50, y);
  doc.text('Resp. Entrepot: ________________', 300, y);
  doc.text('Date: ________________', 550, y);

  // Pied de page
  doc.moveDown(3);
  doc.moveTo(50, doc.y).lineTo(750, doc.y).stroke();
  doc.moveDown();
  doc.fontSize(9).text('Document genere automatiquement par WMS ENSIAS - ' + new Date().toLocaleDateString('fr-FR'), { align: 'center' });

  doc.end();
});

module.exports = router;