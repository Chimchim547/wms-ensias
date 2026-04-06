const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const { statut, recherche, dateDebut, dateFin } = req.query;
  
  const where = {};
  
  if (statut) {
    where.statut = statut;
  }
  
  if (recherche) {
    where.OR = [
      { numero: { contains: recherche, mode: 'insensitive' } },
      { nomClient: { contains: recherche, mode: 'insensitive' } }
    ];
  }
  
  if (dateDebut || dateFin) {
    where.date = {};
    if (dateDebut) where.date.gte = new Date(dateDebut);
    if (dateFin) {
      const fin = new Date(dateFin);
      fin.setHours(23, 59, 59);
      where.date.lte = fin;
    }
  }
  
  const commandes = await prisma.commande.findMany({
    where,
    include: { lignes: { include: { article: true } }, listePicking: true },
    orderBy: { date: 'desc' }
  });
  
  res.render('commandes/index', { 
    commandes, 
    filtres: { statut: statut || '', recherche: recherche || '', dateDebut: dateDebut || '', dateFin: dateFin || '' }
  });
});

router.get('/preparation', async (req, res) => {
  const commandes = await prisma.commande.findMany({
    where: { statut: { in: ['PICKING', 'PREPARE'] } },
    include: { lignes: { include: { article: true } }, listePicking: true }
  });
  res.render('commandes/preparation', { commandes });
});

router.get('/create', async (req, res) => {
  const articles = await prisma.article.findMany();
  res.render('commandes/create', { articles });
});

router.post('/create', async (req, res) => {
  try {
    const { numero, nomClient, emailClient, adresseClient, articleIds, quantites } = req.body;
    const lignes = [];
    const ids = Array.isArray(articleIds) ? articleIds : [articleIds];
    const qtes = Array.isArray(quantites) ? quantites : [quantites];
    let prixTotal = 0;
    
    for (let i = 0; i < ids.length; i++) {
      const article = await prisma.article.findUnique({ where: { id: parseInt(ids[i]) } });
      prixTotal += article.prix * parseInt(qtes[i]);
      lignes.push({
        articleId: parseInt(ids[i]),
        quantite: parseInt(qtes[i])
      });
    }
    
    await prisma.commande.create({
      data: {
        numero, nomClient, emailClient, adresseClient, prixTotal,
        statut: 'EN_ATTENTE',
        lignes: { create: lignes }
      }
    });

   // Pas de notif pour soi-même, la notif au magasinier viendra au moment du picking

    res.redirect('/commandes');
  } catch (err) {
    res.status(400).render('error', { message: 'Erreur: ' + err.message });
  }
});

router.post('/picking/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  
  const existant = await prisma.listePicking.findUnique({
    where: { commandeId: commandeId }
  });
  
  if (existant) {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: true } } }
  });
  
  const lignesPicking = commande.lignes.map(l => ({
    articleId: l.articleId,
    quantite: l.quantite
  }));
  
  await prisma.listePicking.create({
    data: {
      commandeId,
      lignes: { create: lignesPicking }
    }
  });
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'PICKING' }
  });

  // Notif pour le magasinier
  await prisma.notification.create({
    data: {
      message: `Commande ${commande.numero} : liste de picking générée. Veuillez prélever les ${commande.lignes.length} articles.`,
      lien: '/commandes/picking/' + commandeId,
      destinataireRole: 'MAGASINIER'
    }
  });

  res.redirect('/commandes');
});

router.get('/picking/:id', async (req, res) => {
  const commande = await prisma.commande.findUnique({
    where: { id: parseInt(req.params.id) },
    include: {
      lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } },
      listePicking: { include: { lignes: { include: { article: { include: { emplacement: { include: { zone: true } } } } } } } }
    }
  });
  res.render('commandes/picking', { commande });
});

router.post('/preparer/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { ligneIds, quantitesPrelevees } = req.body;
  
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { 
      listePicking: { include: { lignes: true } },
      lignes: true 
    }
  });
  
  if (commande.statut === 'PREPARE' || commande.statut === 'AU_QUAI' || commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  const ids = Array.isArray(ligneIds) ? ligneIds : [ligneIds];
  const qps = Array.isArray(quantitesPrelevees) ? quantitesPrelevees : [quantitesPrelevees];
  
  let toutComplet = true;
  let articlesManquants = [];
  
  for (let i = 0; i < ids.length; i++) {
    const qp = parseInt(qps[i]) || 0;
    const ligne = commande.listePicking.lignes.find(l => l.id === parseInt(ids[i]));
    
    if (qp < ligne.quantite) {
      toutComplet = false;
      articlesManquants.push(`${ligne.quantite - qp} manquant(s)`);
    }
    
    await prisma.lignePicking.update({
      where: { id: parseInt(ids[i]) },
      data: { quantitePrelevee: qp }
    });
  }
  
  for (let i = 0; i < commande.lignes.length; i++) {
    const lignePicking = commande.listePicking.lignes.find(l => l.articleId === commande.lignes[i].articleId);
    const idx = ids.indexOf(String(lignePicking.id));
    const qp = parseInt(qps[idx]) || 0;
    
    await prisma.ligneCommande.update({
      where: { id: commande.lignes[i].id },
      data: { quantitePreparee: qp }
    });
  }
  
  if (toutComplet) {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PREPARE' }
    });

    // Notif responsable commande : préparation complète
    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : tous les articles ont été prélevés avec succès. Prête pour le quai d'expédition.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'RESPONSABLE_COMMANDE'
      }
    });
  } else {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PARTIELLE' }
    });

    // Notif responsable commande : commande partielle
    await prisma.notification.create({
      data: {
        message: `⚠ Commande ${commande.numero} : préparation partielle ! Certains articles n'ont pas été trouvés. Votre décision est requise.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'RESPONSABLE_COMMANDE'
      }
    });
  }

  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/decision/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const { decision } = req.body;
  const commande = await prisma.commande.findUnique({ where: { id: commandeId } });
  
  if (decision === 'expedier_partiel') {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'PREPARE' }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : le client accepte l'expédition partielle. Veuillez déplacer les articles vers le quai.`,
        lien: '/commandes/picking/' + commandeId,
        destinataireRole: 'MAGASINIER'
      }
    });
  } else if (decision === 'attendre') {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'EN_ATTENTE_STOCK' }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} : le client préfère attendre. Commande mise en attente de réapprovisionnement.`,
        lien: '/commandes',
        destinataireRole: 'RESPONSABLE_ENTREPOT'
      }
    });
  } else if (decision === 'annuler') {
    await prisma.commande.update({
      where: { id: commandeId },
      data: { statut: 'ANNULEE' }
    });

    await prisma.notification.create({
      data: {
        message: `Commande ${commande.numero} annulée par le client. Les articles doivent être remis en stock.`,
        lien: '/commandes',
        destinataireRole: 'MAGASINIER'
      }
    });
  }
  
  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/deplacer-quai/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: { include: { article: true } } }
  });
  
  if (commande.statut === 'AU_QUAI' || commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes/picking/' + commandeId);
  }
  
  for (const ligne of commande.lignes) {
    if (ligne.article.emplacementId) {
      await prisma.article.update({
        where: { id: ligne.articleId },
        data: { emplacementId: null }
      });
      
      await prisma.mouvementStock.create({
        data: {
          type: 'TRANSFERT',
          quantite: ligne.quantitePreparee || ligne.quantite,
          articleId: ligne.articleId
        }
      });
    }
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'AU_QUAI' }
  });

  // Notif responsable commande : articles au quai
  await prisma.notification.create({
    data: {
      message: `Commande ${commande.numero} : les articles sont au quai d'expédition. Vous pouvez valider l'expédition.`,
      lien: '/commandes/picking/' + commandeId,
      destinataireRole: 'RESPONSABLE_COMMANDE'
    }
  });

  res.redirect('/commandes/picking/' + commandeId);
});

router.post('/expedier/:id', async (req, res) => {
  const commandeId = parseInt(req.params.id);
  const commande = await prisma.commande.findUnique({
    where: { id: commandeId },
    include: { lignes: true }
  });
  
  if (commande.statut === 'EXPEDIEE') {
    return res.redirect('/commandes');
  }
  
  for (const ligne of commande.lignes) {
    const qte = ligne.quantitePreparee || ligne.quantite;
    await prisma.mouvementStock.create({
      data: {
        type: 'SORTIE',
        quantite: qte,
        articleId: ligne.articleId
      }
    });
  }
  
  await prisma.commande.update({
    where: { id: commandeId },
    data: { statut: 'EXPEDIEE' }
  });

  // Notif responsable entrepôt : stock mis à jour
  await prisma.notification.create({
    data: {
      message: `Commande ${commande.numero} expédiée. Le stock a été mis à jour automatiquement.`,
      lien: '/articles/stock',
      destinataireRole: 'RESPONSABLE_ENTREPOT'
    }
  });

  res.redirect('/commandes');
});

module.exports = router;